output "state_bucket" {
  description = "Use as -backend-config=bucket=... for infra/prod and infra/preview (and for this stack after migration)."
  value       = aws_s3_bucket.state.id
}

# Set these as GitHub repo variables (non-secret, DESIGN §6).
output "repo_variables" {
  description = "GitHub repo variables to set (gh variable set NAME --body VALUE)."
  value = {
    AWS_ACCOUNT_ID               = var.aws_account_id
    AWS_ROLE_CI_ARN              = aws_iam_role.github["kcw-gh-ci"].arn
    AWS_ROLE_PLAN_ARN            = aws_iam_role.github["kcw-gh-plan"].arn
    AWS_ROLE_DEPLOY_ARN          = aws_iam_role.github["kcw-gh-deploy"].arn
    AWS_ROLE_AGENT_DEVELOPER_ARN = aws_iam_role.github["kcw-gh-agent-developer"].arn
    AWS_ROLE_AGENT_QA_ARN        = aws_iam_role.github["kcw-gh-agent-qa"].arn
    AWS_ROLE_AGENT_SCRAPER_ARN   = aws_iam_role.github["kcw-gh-agent-scraper"].arn
    AWS_ROLE_AGENT_DOCS_ARN      = aws_iam_role.github["kcw-gh-agent-docs"].arn
    TF_STATE_BUCKET              = aws_s3_bucket.state.id
  }
}

output "role_subjects" {
  description = "The exact OIDC sub each role trusts."
  value       = local.role_subs
}

output "preview_boundary_arn" {
  value = aws_iam_policy.preview_boundary.arn
}

output "certificate_arn" {
  description = "us-east-1 certificate for the domain, *.domain and *.preview.domain (null without a domain)."
  value       = local.has_domain ? aws_acm_certificate_validation.this[0].certificate_arn : null
}

output "secret_names" {
  value = sort(keys(aws_secretsmanager_secret.this))
}
