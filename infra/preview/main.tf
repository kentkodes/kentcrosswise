# infra/preview: one per-PR copy of the web app against its Neon branch (DESIGN §5, D21).
# Init:  terraform init -backend-config="bucket=kentcrosswise-tfstate-<account-id>" \
#                       -backend-config="key=preview/pr-<n>.tfstate"
# Apply: terraform apply -var pr_number=<n> -var database_url=<pooled url>   (KCW_ENV=preview build)
# Check after destroy: pnpm check-preview-clean --pr <n>

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
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6"
    }
  }

  backend "s3" {
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}

variable "pr_number" {
  description = "Pull request number (0 for the manual test)."
  type        = number

  validation {
    condition     = var.pr_number >= 0 && floor(var.pr_number) == var.pr_number
    error_message = "pr_number must be a non-negative integer."
  }
}

variable "database_url" {
  description = "Pooled URL of the Neon branch preview/pr-<n>. Ephemeral: never stored in state or plan files."
  type        = string
  sensitive   = true
  ephemeral   = true
}

variable "domain_name" {
  description = "Apex domain. Empty (default): the preview is served on its CloudFront URL (D22)."
  type        = string
  default     = ""
}

variable "artifact_dir" {
  description = "OpenNext output of a preview build (KCW_ENV=preview pnpm build-web)."
  type        = string
  default     = "../../apps/web/.open-next"
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      "kcw:env"        = "preview"
      "kcw:pr"         = tostring(var.pr_number)
      "kcw:managed-by" = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  name       = "kcw-pr-${var.pr_number}"
  has_domain = var.domain_name != ""
  host       = "pr-${var.pr_number}.preview.${var.domain_name}"
  db_param   = "/kcw/preview/pr-${var.pr_number}/database-url"
  boundary   = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:policy/kcw-preview-boundary"
}

data "aws_route53_zone" "this" {
  count        = local.has_domain ? 1 : 0
  name         = var.domain_name
  private_zone = false
}

# The bootstrap certificate (apex, *.apex, *.preview.apex).
data "aws_acm_certificate" "this" {
  count       = local.has_domain ? 1 : 0
  domain      = var.domain_name
  statuses    = ["ISSUED"]
  most_recent = true
}

# D21: the per-PR DB URL lives in an SSM SecureString (AWS-managed key), readable only by this
# preview's server role. Write-only value: Terraform sends it but does not keep it.
resource "aws_ssm_parameter" "database_url" {
  name             = local.db_param
  type             = "SecureString"
  value_wo         = var.database_url
  value_wo_version = 1
  description      = "Neon branch preview/pr-${var.pr_number} (synthetic data)"
}

# D25: per-preview origin header value, generated here (no secret to fill). The server reads it
# from this SecureString; CloudFront sends it. It lives in this preview's state until destroy.
resource "random_password" "origin_verify" {
  length  = 48
  special = false
}

resource "aws_ssm_parameter" "origin_verify" {
  name        = "/kcw/preview/pr-${var.pr_number}/origin-verify"
  type        = "SecureString"
  value       = random_password.origin_verify.result
  description = "CloudFront origin header for preview pr-${var.pr_number} (D25)"
}

module "web" {
  source = "../modules/web"

  kcw_env                  = "preview"
  name_prefix              = local.name
  artifact_dir             = var.artifact_dir
  force_destroy            = true
  permissions_boundary_arn = local.boundary
  log_retention_days       = 3
  domain_names             = local.has_domain ? [local.host] : []
  acm_certificate_arn      = local.has_domain ? data.aws_acm_certificate.this[0].arn : null
  route53_zone_id          = local.has_domain ? data.aws_route53_zone.this[0].zone_id : null
  secret_names             = ["kcw/ci"]
  ssm_parameter_names      = [aws_ssm_parameter.database_url.name]

  origin_verify_value       = random_password.origin_verify.result
  origin_verify_secret_name = aws_ssm_parameter.origin_verify.name

  server_environment = {
    KCW_CI_SECRET          = "kcw/ci"
    KCW_DATABASE_URL_PARAM = aws_ssm_parameter.database_url.name
  }
}

output "url" {
  value = module.web.url
}

output "distribution_id" {
  value = module.web.distribution_id
}
