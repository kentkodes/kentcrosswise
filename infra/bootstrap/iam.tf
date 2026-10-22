# GitHub OIDC provider and the four workflow roles (DESIGN §5). Every trust policy pins the audience
# and exact immutable `sub` values (repo:OWNER@OWNER_ID/REPO@REPO_ID:<context>).

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # No thumbprint: AWS no longer uses it for this provider (research/infra.md §3).
}

locals {
  oidc_host = "token.actions.githubusercontent.com"

  # kcw-gh-ci also serves preview-gc.yml's sweep job (dispatch/schedule on main), which runs in
  # environment preview-gc so that agent workflows on main (ref:refs/heads/main) cannot use this role.
  role_subs = {
    "kcw-gh-ci"     = ["${local.github_sub}:pull_request", "${local.github_sub}:environment:preview-gc"]
    "kcw-gh-plan"   = ["${local.github_sub}:pull_request"]
    "kcw-gh-deploy" = ["${local.github_sub}:environment:prod"]
    "kcw-gh-agent"  = ["${local.github_sub}:ref:refs/heads/main"]
  }

  state_arn     = aws_s3_bucket.state.arn
  arn_prefix    = "arn:${local.partition}"
  lambda_arn    = "${local.arn_prefix}:lambda:${local.region}:${local.account_id}"
  logs_arn      = "${local.arn_prefix}:logs:${local.region}:${local.account_id}"
  sqs_arn       = "${local.arn_prefix}:sqs:${local.region}:${local.account_id}"
  ssm_arn       = "${local.arn_prefix}:ssm:${local.region}:${local.account_id}"
  iam_arn       = "${local.arn_prefix}:iam::${local.account_id}"
  cf_arn        = "${local.arn_prefix}:cloudfront::${local.account_id}"
  github_apps   = ["developer", "qa", "scraper", "docs"]
  preview_names = "kcw-pr-*"
}

data "aws_iam_policy_document" "trust" {
  for_each = local.role_subs

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = each.value
    }
  }
}

resource "aws_iam_role" "github" {
  for_each             = local.role_subs
  name                 = each.key
  assume_role_policy   = data.aws_iam_policy_document.trust[each.key].json
  max_session_duration = 3600
}

# ---------- preview permissions boundary ----------
# Every role that kcw-gh-ci creates must carry this boundary, so a preview Lambda can never do more
# than this, whatever inline policy a PR writes.

data "aws_iam_policy_document" "preview_boundary" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${local.logs_arn}:log-group:/aws/lambda/${local.preview_names}:*"]
  }
  statement {
    sid       = "PreviewBuckets"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = ["${local.arn_prefix}:s3:::${local.preview_names}", "${local.arn_prefix}:s3:::${local.preview_names}/*"]
  }
  statement {
    sid       = "PreviewQueues"
    actions   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = ["${local.sqs_arn}:${local.preview_names}"]
  }
  statement {
    sid       = "PreviewParameters"
    actions   = ["ssm:GetParameter"]
    resources = ["${local.ssm_arn}:parameter/kcw/preview/*"]
  }
  statement {
    sid       = "CiSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${local.secret_arn}:kcw/ci-??????"]
  }
}

resource "aws_iam_policy" "preview_boundary" {
  name        = "kcw-preview-boundary"
  description = "Permissions boundary for every role created by kcw-gh-ci (preview Lambdas)."
  policy      = data.aws_iam_policy_document.preview_boundary.json
}

# ---------- kcw-gh-ci: preview stacks ----------

data "aws_iam_policy_document" "ci" {
  statement {
    sid       = "PreviewState"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${local.state_arn}/preview/*"]
  }
  statement {
    sid       = "PreviewStateList"
    actions   = ["s3:ListBucket"]
    resources = [local.state_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["preview/*"]
    }
  }
  statement {
    sid       = "CiSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${local.secret_arn}:kcw/ci-??????"]
  }
  statement {
    sid = "PreviewParameters"
    actions = [
      "ssm:PutParameter", "ssm:DeleteParameter", "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath",
      "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource", "ssm:ListTagsForResource",
    ]
    resources = ["${local.ssm_arn}:parameter/kcw/preview/*"]
  }
  statement {
    sid       = "PreviewFunctions"
    actions   = ["lambda:*"]
    resources = ["${local.lambda_arn}:function:${local.preview_names}"]
  }
  statement {
    sid       = "PreviewEventSourceMappingCreate"
    actions   = ["lambda:CreateEventSourceMapping"]
    resources = ["*"]
    condition {
      test     = "ArnLike"
      variable = "lambda:FunctionArn"
      values   = ["${local.lambda_arn}:function:${local.preview_names}"]
    }
  }
  statement {
    sid = "PreviewEventSourceMappings"
    actions = [
      "lambda:GetEventSourceMapping", "lambda:DeleteEventSourceMapping", "lambda:UpdateEventSourceMapping",
      "lambda:ListTags", "lambda:TagResource", "lambda:UntagResource",
    ]
    resources = ["${local.lambda_arn}:event-source-mapping:*"]
  }
  # Once a mapping is gone, Lambda authorizes GetEventSourceMapping against "*" (not the mapping
  # ARN) and answers AccessDenied instead of NotFound. The provider's delete waiter polls until
  # NotFound, so without this every destroy stopped at the mapping (CI run 39853350799).
  statement {
    sid       = "EventSourceMappingDeleteWaiter"
    actions   = ["lambda:GetEventSourceMapping"]
    resources = ["*"]
  }
  statement {
    sid = "PreviewRolesWithBoundary"
    actions = [
      "iam:CreateRole", "iam:PutRolePolicy",
    ]
    resources = ["${local.iam_arn}:role/${local.preview_names}"]
    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.preview_boundary.arn]
    }
  }
  statement {
    sid = "PreviewRoles"
    actions = [
      "iam:GetRole", "iam:DeleteRole", "iam:TagRole", "iam:UntagRole", "iam:GetRolePolicy", "iam:DeleteRolePolicy",
      "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:ListRoleTags",
    ]
    resources = ["${local.iam_arn}:role/${local.preview_names}"]
  }
  statement {
    sid       = "PassPreviewRolesToLambda"
    actions   = ["iam:PassRole"]
    resources = ["${local.iam_arn}:role/${local.preview_names}"]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }
  statement {
    sid       = "PreviewBuckets"
    actions   = ["s3:*"]
    resources = ["${local.arn_prefix}:s3:::${local.preview_names}", "${local.arn_prefix}:s3:::${local.preview_names}/*"]
  }
  statement {
    sid       = "PreviewQueues"
    actions   = ["sqs:*"]
    resources = ["${local.sqs_arn}:${local.preview_names}"]
  }
  statement {
    sid = "PreviewLogs"
    actions = [
      "logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:PutRetentionPolicy", "logs:DeleteRetentionPolicy",
      "logs:TagResource", "logs:UntagResource", "logs:ListTagsForResource", "logs:TagLogGroup", "logs:ListTagsLogGroup",
    ]
    resources = ["${local.logs_arn}:log-group:/aws/lambda/${local.preview_names}", "${local.logs_arn}:log-group:/aws/lambda/${local.preview_names}:*"]
  }
  # The provider sends the default tags with CreateFunction, which CloudFront authorizes as
  # cloudfront:TagResource on the function as well.
  statement {
    sid = "PreviewCloudFrontFunctions"
    actions = [
      "cloudfront:UpdateFunction", "cloudfront:PublishFunction", "cloudfront:DeleteFunction", "cloudfront:DescribeFunction",
      "cloudfront:GetFunction", "cloudfront:TagResource", "cloudfront:UntagResource",
    ]
    resources = ["${local.cf_arn}:function/${local.preview_names}"]
  }
  # CreateFunction and CreateDistribution have no resource type in the IAM reference (resource "*"),
  # so they are scoped by the request tag instead.
  statement {
    sid       = "CreatePreviewFunctionsAndDistributions"
    actions   = ["cloudfront:CreateFunction", "cloudfront:CreateDistribution"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/kcw:env"
      values   = ["preview"]
    }
  }
  statement {
    sid       = "TagNewPreviewDistributions"
    actions   = ["cloudfront:TagResource"]
    resources = ["${local.cf_arn}:distribution/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/kcw:env"
      values   = ["preview"]
    }
  }
  statement {
    sid       = "ChangePreviewDistributions"
    actions   = ["cloudfront:UpdateDistribution", "cloudfront:DeleteDistribution", "cloudfront:UntagResource"]
    resources = ["${local.cf_arn}:distribution/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/kcw:env"
      values   = ["preview"]
    }
  }
  # OACs and cache policies have random ids, so they cannot be scoped by name.
  statement {
    sid = "CloudFrontPoliciesAndOac"
    actions = [
      "cloudfront:CreateOriginAccessControl", "cloudfront:GetOriginAccessControl", "cloudfront:UpdateOriginAccessControl", "cloudfront:DeleteOriginAccessControl",
      "cloudfront:CreateCachePolicy", "cloudfront:GetCachePolicy", "cloudfront:UpdateCachePolicy", "cloudfront:DeleteCachePolicy",
    ]
    resources = ["*"]
  }
  statement {
    sid = "ReadOnlyForRefreshAndCleanCheck"
    actions = [
      "cloudfront:Get*", "cloudfront:List*", "cloudfront:Describe*",
      "lambda:ListEventSourceMappings", "logs:DescribeLogGroups", "ssm:DescribeParameters",
      "acm:ListCertificates", "acm:DescribeCertificate", "acm:ListTagsForCertificate", "route53:ListHostedZones", "route53:ListHostedZonesByName",
      "route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:GetChange", "route53:ListTagsForResource",
      "tag:GetResources", "iam:ListRoles",
    ]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = local.has_domain ? [1] : []
    content {
      sid       = "PreviewDnsRecords"
      actions   = ["route53:ChangeResourceRecordSets"]
      resources = [data.aws_route53_zone.this[0].arn]
      condition {
        test     = "ForAllValues:StringLike"
        variable = "route53:ChangeResourceRecordSetsNormalizedRecordNames"
        values   = ["pr-*.preview.${var.domain_name}"]
      }
    }
  }

  statement {
    sid       = "NoBoundaryEscape"
    effect    = "Deny"
    actions   = ["iam:DeleteRolePermissionsBoundary", "iam:PutRolePermissionsBoundary", "iam:AttachRolePolicy", "iam:UpdateAssumeRolePolicy"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ci" {
  name   = "kcw-gh-ci"
  role   = aws_iam_role.github["kcw-gh-ci"].id
  policy = data.aws_iam_policy_document.ci.json
}

# ---------- kcw-gh-plan: read-only prod plan on PRs ----------
# AWS ReadOnlyAccess, minus anything that reads data rather than configuration.

resource "aws_iam_role_policy_attachment" "plan_readonly" {
  role       = aws_iam_role.github["kcw-gh-plan"].name
  policy_arn = "${local.arn_prefix}:iam::aws:policy/ReadOnlyAccess"
}

data "aws_iam_policy_document" "plan" {
  statement {
    sid       = "ProdStateRead"
    actions   = ["s3:GetObject"]
    resources = ["${local.state_arn}/prod.tfstate"]
  }
  # D25: the prod plan needs the origin header value; it is in the prod state anyway.
  statement {
    sid       = "OriginVerifySecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${local.secret_arn}:kcw/prod/origin-verify-??????"]
  }
  statement {
    sid           = "NoOtherSecretValues"
    effect        = "Deny"
    actions       = ["secretsmanager:GetSecretValue"]
    not_resources = ["${local.secret_arn}:kcw/prod/origin-verify-??????"]
  }
  statement {
    sid    = "NoDataReads"
    effect = "Deny"
    actions = [
      "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath",
      "sqs:ReceiveMessage", "logs:GetLogEvents", "logs:FilterLogEvents", "logs:StartQuery",
      "logs:GetQueryResults", "logs:StartLiveTail", "dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query",
      "dynamodb:Scan", "lambda:InvokeFunction", "lambda:InvokeFunctionUrl",
    ]
    resources = ["*"]
  }
  # KMS decrypt only through Secrets Manager, which itself is limited to origin-verify above, and
  # through Lambda, which decrypts function environment variables with the caller's permissions.
  # Without Lambda, refresh reads every function's environment as empty and each prod plan shows a
  # spurious change to environment.0.variables (CI run 39853350799). Function environments hold
  # names only, never secret values (D9).
  # A plain Deny on kms:Decrypt would also block reading that secret: Secrets Manager decrypts with
  # the caller's permissions.
  statement {
    sid       = "NoDecryptOutsideSecretsManagerAndLambda"
    effect    = "Deny"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${local.region}.amazonaws.com", "lambda.${local.region}.amazonaws.com"]
    }
  }
  # Object reads only for the prod state and the web bucket's public build output (needed to refresh
  # aws_s3_object): _assets/ (static files) and _cache/ (prerendered public pages, no private data).
  statement {
    sid     = "NoObjectReadsOutsideStateAndAssets"
    effect  = "Deny"
    actions = ["s3:GetObject", "s3:GetObjectVersion"]
    not_resources = [
      "${local.state_arn}/prod.tfstate",
      "${local.arn_prefix}:s3:::kcw-prod-assets-${local.account_id}/_assets/*",
      "${local.arn_prefix}:s3:::kcw-prod-assets-${local.account_id}/_cache/*",
    ]
  }
}

resource "aws_iam_role_policy" "plan" {
  name   = "kcw-gh-plan"
  role   = aws_iam_role.github["kcw-gh-plan"].id
  policy = data.aws_iam_policy_document.plan.json
}

# ---------- kcw-gh-deploy: prod apply (environment prod) ----------

resource "aws_iam_role_policy_attachment" "deploy_poweruser" {
  role       = aws_iam_role.github["kcw-gh-deploy"].name
  policy_arn = "${local.arn_prefix}:iam::aws:policy/PowerUserAccess"
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "ProdState"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${local.state_arn}/prod.tfstate", "${local.state_arn}/prod.tfstate.tflock"]
  }
  statement {
    sid       = "ProdStateList"
    actions   = ["s3:ListBucket"]
    resources = [local.state_arn]
  }
  statement {
    sid       = "MigratorAndOriginSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${local.secret_arn}:kcw/prod/migrator-??????", "${local.secret_arn}:kcw/prod/origin-verify-??????"]
  }
  statement {
    sid = "ProdRoles"
    actions = [
      "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:TagRole", "iam:UntagRole", "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy",
      "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:ListRoleTags",
    ]
    resources = ["${local.iam_arn}:role/kcw-prod-*"]
  }
  statement {
    sid       = "PassProdRoles"
    actions   = ["iam:PassRole"]
    resources = ["${local.iam_arn}:role/kcw-prod-*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com", "scheduler.amazonaws.com", "events.amazonaws.com"]
    }
  }
  statement {
    sid       = "NoOtherSecretValues"
    effect    = "Deny"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["*"]
    condition {
      test     = "StringNotLike"
      variable = "secretsmanager:SecretId"
      values   = ["${local.secret_arn}:kcw/prod/migrator-??????", "${local.secret_arn}:kcw/prod/origin-verify-??????"]
    }
  }
  statement {
    sid    = "BootstrapIsOwnerOnly"
    effect = "Deny"
    actions = [
      "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecret", "secretsmanager:DeleteSecret",
      "secretsmanager:PutResourcePolicy", "s3:DeleteBucket", "s3:PutBucketPolicy", "s3:PutBucketVersioning",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "kcw-gh-deploy"
  role   = aws_iam_role.github["kcw-gh-deploy"].id
  policy = data.aws_iam_policy_document.deploy.json
}

# ---------- kcw-gh-agent: agent workflows on main ----------

data "aws_iam_policy_document" "agent" {
  dynamic "statement" {
    for_each = local.github_apps
    content {
      sid       = "${title(statement.value)}AppKey"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = ["${local.secret_arn}:kcw/github/${statement.value}-app-??????"]
    }
  }
  statement {
    sid       = "ReportToOrchestrator"
    actions   = ["sqs:SendMessage"]
    resources = ["${local.sqs_arn}:${var.orchestrator_queue_name}"]
  }
}

resource "aws_iam_role_policy" "agent" {
  name   = "kcw-gh-agent"
  role   = aws_iam_role.github["kcw-gh-agent"].id
  policy = data.aws_iam_policy_document.agent.json
}
