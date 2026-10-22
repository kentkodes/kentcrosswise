# infra/prod: everything in production. Phase 1: the web app only (P1-11).
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

  server_environment = {
    KCW_WEB_SECRET = "kcw/prod/web"
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
