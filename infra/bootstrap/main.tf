# infra/bootstrap: applied once by the owner with their own admin credentials (AWS_PROFILE=kc-admin).
# Starts with local state; docs/runbooks/bootstrap.md moves it into the bucket created here.

terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      "kcw:env"        = "bootstrap"
      "kcw:managed-by" = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {
  lifecycle {
    postcondition {
      condition     = self.account_id == var.aws_account_id
      error_message = "The credentials in use are not for aws_account_id. Check AWS_PROFILE."
    }
  }
}

data "aws_partition" "current" {}

locals {
  partition   = data.aws_partition.current.partition
  account_id  = var.aws_account_id
  region      = var.aws_region
  github_sub  = "repo:${var.github_owner}@${var.github_owner_id}/${var.github_repo}@${var.github_repo_id}"
  state_name  = "kentcrosswise-tfstate-${var.aws_account_id}"
  secret_arn  = "arn:${local.partition}:secretsmanager:${local.region}:${local.account_id}:secret"
  has_domain  = var.domain_name != ""
  preview_tag = { "kcw:env" = "preview" }
}

# ---------- Terraform state bucket ----------

resource "aws_s3_bucket" "state" {
  bucket = local.state_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

data "aws_iam_policy_document" "state_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket     = aws_s3_bucket.state.id
  policy     = data.aws_iam_policy_document.state_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.state]
}

# ---------- ACM certificate (only with a domain, D22) ----------

data "aws_route53_zone" "this" {
  count        = local.has_domain ? 1 : 0
  name         = var.domain_name
  private_zone = false
}

resource "aws_acm_certificate" "this" {
  count                     = local.has_domain ? 1 : 0
  domain_name               = var.domain_name
  subject_alternative_names = ["*.${var.domain_name}", "*.preview.${var.domain_name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  # The apex and *.apex share one validation record, so key by record name.
  for_each = local.has_domain ? {
    for o in aws_acm_certificate.this[0].domain_validation_options : o.resource_record_name => o...
  } : {}

  zone_id         = data.aws_route53_zone.this[0].zone_id
  name            = each.key
  type            = each.value[0].resource_record_type
  records         = [each.value[0].resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  count                   = local.has_domain ? 1 : 0
  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}
