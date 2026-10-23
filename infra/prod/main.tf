# infra/prod: everything in production: the web app (P1-11) and the orchestrator (P2-06).
# Init: terraform init -backend-config="bucket=kentcrosswise-tfstate-<account-id>"

terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }
  }

  backend "s3" {
    key          = "prod.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      "kcw:env"        = "prod"
      "kcw:managed-by" = "terraform"
    }
  }
}

variable "domain_name" {
  description = "Apex domain, e.g. kentcrosswise.com. Empty (default): serve on the CloudFront URL only (D22)."
  type        = string
  default     = ""
}

variable "artifact_dir" {
  description = "OpenNext output of a prod build (pnpm build-web)."
  type        = string
  default     = "../../apps/web/.open-next"
}

variable "orchestrator_package_dir" {
  description = "Orchestrator Lambda code directory (index.mjs exporting handler), built by pnpm build-lambdas (run it before plan/apply)."
  type        = string
  default     = "../../agents/orchestrator/dist"
}

variable "relay_package_dir" {
  description = "Webhook relay Lambda code directory (index.mjs exporting handler), built by pnpm build-lambdas (run it before plan/apply)."
  type        = string
  default     = "../../agents/webhook-relay/dist"
}

variable "relay_allowed_sender_ids" {
  description = "GitHub account ids the webhook relay accepts events from. Default: the owner (D23). P2-07 adds the five App bot ids."
  type        = list(number)
  default     = [107236483]
}

locals {
  has_domain = var.domain_name != ""
}

# The hosted zone comes from domain registration and the certificate from infra/bootstrap;
# both are looked up, never created here.
data "aws_route53_zone" "this" {
  count        = local.has_domain ? 1 : 0
  name         = var.domain_name
  private_zone = false
}

data "aws_acm_certificate" "this" {
  count       = local.has_domain ? 1 : 0
  domain      = var.domain_name
  statuses    = ["ISSUED"]
  most_recent = true
}

# D25: the CloudFront -> server origin header value. Its own secret (filled by the owner), so the
# PR plan role can read this one value without reading kcw/prod/web.
locals {
  origin_verify_secret = "kcw/prod/origin-verify"
}

data "aws_secretsmanager_secret_version" "origin_verify" {
  secret_id = local.origin_verify_secret
}

module "web_secrets" {
  source = "../modules/secrets"
  names  = ["kcw/prod/web"]
}

module "web" {
  source = "../modules/web"

  kcw_env             = "prod"
  name_prefix         = "kcw-prod"
  artifact_dir        = var.artifact_dir
  domain_names        = local.has_domain ? [var.domain_name] : []
  acm_certificate_arn = local.has_domain ? data.aws_acm_certificate.this[0].arn : null
  route53_zone_id     = local.has_domain ? data.aws_route53_zone.this[0].zone_id : null
  secret_names        = module.web_secrets.names

  origin_verify_value       = jsondecode(data.aws_secretsmanager_secret_version.origin_verify.secret_string)["origin_verify"]
  origin_verify_secret_name = local.origin_verify_secret
  origin_verify_secret_key  = "origin_verify"

  # Boss console and inbox (P2-14) send to the orchestrator input queue. The queue is SSE-SQS
  # (sqs_managed_sse_enabled), so no KMS permission is needed.
  server_send_queue_arns = [module.orchestrator.queue_arn]

  server_environment = {
    KCW_WEB_SECRET             = "kcw/prod/web"
    KCW_ORCHESTRATOR_QUEUE_URL = module.orchestrator.queue_url
  }
}

# ---------- orchestrator (P2-06) ----------
# Each Lambda reads only its own secrets (DESIGN §6); env vars carry the names (D9).

module "orchestrator_secrets" {
  source = "../modules/secrets"
  names  = ["kcw/prod/orchestrator", "kcw/prod/models"]
}

# Relay (P2-05): the webhook secret, plus its own DB secret so it cannot read the orchestrator's
# App key in kcw/prod/orchestrator. Both containers come from infra/bootstrap.
locals {
  relay_webhook_secret = "kcw/github/webhook-secret"
  relay_db_secret      = "kcw/prod/relay"
}

module "relay_secrets" {
  source = "../modules/secrets"
  names  = [local.relay_webhook_secret, local.relay_db_secret]
}

module "orchestrator" {
  source = "../modules/orchestrator"

  name_prefix              = "kcw-prod"
  orchestrator_package_dir = var.orchestrator_package_dir
  relay_package_dir        = var.relay_package_dir

  orchestrator_secret_names = module.orchestrator_secrets.names

  # The lookups above make the plan fail early if a secret container is missing.
  relay_webhook_secret_name = module.relay_secrets.names[0]
  relay_db_secret_name      = module.relay_secrets.names[1]
  relay_allowed_sender_ids  = var.relay_allowed_sender_ids

  orchestrator_environment = {
    KCW_ORCHESTRATOR_SECRET = "kcw/prod/orchestrator"
    KCW_MODELS_SECRET       = "kcw/prod/models"
  }
}

output "url" {
  value = module.web.url
}

output "cloudfront_domain_name" {
  value = module.web.cloudfront_domain_name
}

output "distribution_id" {
  value = module.web.distribution_id
}

output "orchestrator_queue_url" {
  value = module.orchestrator.queue_url
}

output "relay_url" {
  description = "Webhook URL for the orchestrator GitHub App (P2-07)."
  value       = module.orchestrator.relay_url
}
