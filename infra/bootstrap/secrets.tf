# Empty secret containers (DESIGN §6, D19, D25). Values are pasted by the owner in the console
# (Secrets Manager > secret > Retrieve secret value > Edit > Key/value). Terraform never holds a value.

locals {
  secrets = {
    "kcw/prod/web"                = "auth_secret, google_client_id, google_client_secret, owner_email, vapid_public, vapid_private, db_url, db_url_public"
    "kcw/prod/models"             = "anthropic_api_key, typesafe_api_key, langsmith_api_key"
    "kcw/prod/orchestrator"       = "db_url, github_app_client_id, github_app_installation_id, github_app_private_key"
    "kcw/prod/pipeline"           = "db_url"
    "kcw/prod/migrator"           = "db_url"
    "kcw/prod/origin-verify"      = "origin_verify (long random value; CloudFront sends it to the server, which checks it, D25)"
    "kcw/prod/google-owner-token" = "refresh_token (written by the web app at consent)"
    "kcw/prod/social/instagram"   = "app_id, app_secret, long_lived_token (rewritten on refresh)"
    "kcw/prod/social/tiktok"      = "client_key, client_secret, refresh_token (rewritten; may rotate)"
    "kcw/github/webhook-secret"   = "secret"
    "kcw/github/developer-app"    = "private_key"
    "kcw/github/qa-app"           = "private_key"
    "kcw/github/scraper-app"      = "private_key"
    "kcw/github/docs-app"         = "private_key"
    "kcw/ci"                      = "neon_api_key, e2e_login"
  }
}

resource "aws_secretsmanager_secret" "this" {
  for_each    = local.secrets
  name        = each.key
  description = "Keys: ${each.value}. See DESIGN.md section 6."
}
