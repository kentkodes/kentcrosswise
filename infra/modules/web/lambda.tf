# Server, image-optimization and revalidation functions (arm64). Each has its own role.

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ---------- server ----------

data "archive_file" "server" {
  type             = "zip"
  output_file_mode = "0644"
  source_dir       = "${var.artifact_dir}/server-functions/default"
  output_path      = "${local.zip_dir}/${local.server_name}.zip"
}

resource "aws_cloudwatch_log_group" "server" {
  name              = "/aws/lambda/${local.server_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "server" {
  name                 = local.server_name
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
}

data "aws_iam_policy_document" "server" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.server.arn}:*"]
  }

  statement {
    sid       = "IsrCache"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.assets.arn}/${local.cache_prefix}/*"]
  }

  statement {
    sid       = "IsrCacheList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.assets.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.cache_prefix}/*"]
    }
  }

  statement {
    sid       = "RevalidationQueue"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.revalidation.arn]
  }

  dynamic "statement" {
    for_each = length(local.secret_arns) > 0 ? [1] : []
    content {
      sid       = "ReadSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.secret_arns
    }
  }

  # SecureStrings use the AWS-managed aws/ssm key, whose key policy allows decryption through SSM.
  dynamic "statement" {
    for_each = length(local.ssm_parameter_arns) > 0 ? [1] : []
    content {
      sid       = "ReadParameters"
      actions   = ["ssm:GetParameter"]
      resources = local.ssm_parameter_arns
    }
  }
}

resource "aws_iam_role_policy" "server" {
  name   = local.server_name
  role   = aws_iam_role.server.id
  policy = data.aws_iam_policy_document.server.json
}

resource "aws_lambda_function" "server" {
  function_name    = local.server_name
  role             = aws_iam_role.server.arn
  filename         = data.archive_file.server.output_path
  source_code_hash = data.archive_file.server.output_base64sha256
  handler          = "index.handler"
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  memory_size      = var.server_memory_mb
  timeout          = var.server_timeout_s

  environment {
    variables = merge(var.server_environment, {
      CACHE_BUCKET_NAME         = aws_s3_bucket.assets.id
      CACHE_BUCKET_KEY_PREFIX   = local.cache_prefix
      CACHE_BUCKET_REGION       = local.region
      OPEN_NEXT_BUILD_ID        = local.build_id
      REVALIDATION_QUEUE_URL    = aws_sqs_queue.revalidation.url
      REVALIDATION_QUEUE_REGION = local.region
    })
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.server.name
  }

  depends_on = [aws_iam_role_policy.server, terraform_data.build_matches_env]
}

resource "aws_lambda_function_url" "server" {
  function_name      = aws_lambda_function.server.function_name
  authorization_type = "AWS_IAM"
  invoke_mode        = "BUFFERED"
}

# CloudFront (OAC) calls the Function URL. Function URLs need lambda:InvokeFunctionUrl and, for
# newer URLs, lambda:InvokeFunction restricted to calls made through the URL.
resource "aws_lambda_permission" "server_url" {
  statement_id           = "CloudFrontInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.server.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.this.arn
  function_url_auth_type = "AWS_IAM"
}

resource "aws_lambda_permission" "server_invoke" {
  statement_id             = "CloudFrontInvokeFunction"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.server.function_name
  principal                = "cloudfront.amazonaws.com"
  source_arn               = aws_cloudfront_distribution.this.arn
  invoked_via_function_url = true
}

# ---------- image optimization ----------

data "archive_file" "image" {
  type             = "zip"
  output_file_mode = "0644"
  source_dir       = "${var.artifact_dir}/image-optimization-function"
  output_path      = "${local.zip_dir}/${local.image_name}.zip"
}

resource "aws_cloudwatch_log_group" "image" {
  name              = "/aws/lambda/${local.image_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "image" {
  name                 = local.image_name
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
}

data "aws_iam_policy_document" "image" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.image.arn}:*"]
  }

  statement {
    sid       = "ReadSourceImages"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.assets.arn}/${local.assets_prefix}/*"]
  }
}

resource "aws_iam_role_policy" "image" {
  name   = local.image_name
  role   = aws_iam_role.image.id
  policy = data.aws_iam_policy_document.image.json
}

resource "aws_lambda_function" "image" {
  function_name    = local.image_name
  role             = aws_iam_role.image.arn
  filename         = data.archive_file.image.output_path
  source_code_hash = data.archive_file.image.output_base64sha256
  handler          = "index.handler"
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  memory_size      = var.image_memory_mb
  timeout          = 25

  environment {
    variables = {
      BUCKET_NAME       = aws_s3_bucket.assets.id
      BUCKET_KEY_PREFIX = local.assets_prefix
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.image.name
  }

  depends_on = [aws_iam_role_policy.image]
}

resource "aws_lambda_function_url" "image" {
  function_name      = aws_lambda_function.image.function_name
  authorization_type = "AWS_IAM"
  invoke_mode        = "BUFFERED"
}

resource "aws_lambda_permission" "image_url" {
  statement_id           = "CloudFrontInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.image.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.this.arn
  function_url_auth_type = "AWS_IAM"
}

resource "aws_lambda_permission" "image_invoke" {
  statement_id             = "CloudFrontInvokeFunction"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.image.function_name
  principal                = "cloudfront.amazonaws.com"
  source_arn               = aws_cloudfront_distribution.this.arn
  invoked_via_function_url = true
}

# ---------- ISR revalidation (queue: sqs-lite) ----------

resource "aws_sqs_queue" "revalidation" {
  name                        = "${local.revalidation_name}.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  visibility_timeout_seconds  = 180
  message_retention_seconds   = 3600
  sqs_managed_sse_enabled     = true
}

data "archive_file" "revalidation" {
  type             = "zip"
  output_file_mode = "0644"
  source_dir       = "${var.artifact_dir}/revalidation-function"
  output_path      = "${local.zip_dir}/${local.revalidation_name}.zip"
}

resource "aws_cloudwatch_log_group" "revalidation" {
  name              = "/aws/lambda/${local.revalidation_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "revalidation" {
  name                 = local.revalidation_name
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
}

data "aws_iam_policy_document" "revalidation" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.revalidation.arn}:*"]
  }

  statement {
    sid       = "ConsumeQueue"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.revalidation.arn]
  }
}

resource "aws_iam_role_policy" "revalidation" {
  name   = local.revalidation_name
  role   = aws_iam_role.revalidation.id
  policy = data.aws_iam_policy_document.revalidation.json
}

resource "aws_lambda_function" "revalidation" {
  function_name    = local.revalidation_name
  role             = aws_iam_role.revalidation.arn
  filename         = data.archive_file.revalidation.output_path
  source_code_hash = data.archive_file.revalidation.output_base64sha256
  handler          = "index.handler"
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = 30

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.revalidation.name
  }

  depends_on = [aws_iam_role_policy.revalidation]
}

resource "aws_lambda_event_source_mapping" "revalidation" {
  event_source_arn = aws_sqs_queue.revalidation.arn
  function_name    = aws_lambda_function.revalidation.arn
  batch_size       = 5
}
