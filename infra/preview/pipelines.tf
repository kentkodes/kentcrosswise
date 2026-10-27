variable "pipelines_preview" {
  description = "Owner opt-in after the bootstrap preview Scheduler/PassRole/boundary permissions are applied. Deploys inert resources (runtime and schedules hard-coded off); runtime IAM is built in the module from exact ARNs. Existing web previews stay unchanged by default."
  type        = bool
  default     = false
}

variable "pipeline_package_dir" {
  type    = string
  default = "../../scripts/dist-pipelines"
}

resource "aws_s3_bucket" "pipeline" {
  count         = var.pipelines_preview ? 1 : 0
  bucket        = "${local.name}-pipelines-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "pipeline" {
  count                   = var.pipelines_preview ? 1 : 0
  bucket                  = aws_s3_bucket.pipeline[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "pipeline" {
  count  = var.pipelines_preview ? 1 : 0
  bucket = aws_s3_bucket.pipeline[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "pipeline" {
  count  = var.pipelines_preview ? 1 : 0
  bucket = aws_s3_bucket.pipeline[0].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

data "aws_iam_policy_document" "pipeline_bucket" {
  count = var.pipelines_preview ? 1 : 0
  statement {
    sid       = "RequireTls"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.pipeline[0].arn, "${aws_s3_bucket.pipeline[0].arn}/*"]
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

resource "aws_s3_bucket_policy" "pipeline" {
  count      = var.pipelines_preview ? 1 : 0
  bucket     = aws_s3_bucket.pipeline[0].id
  policy     = data.aws_iam_policy_document.pipeline_bucket[0].json
  depends_on = [aws_s3_bucket_public_access_block.pipeline]
}

module "pipelines" {
  count                    = var.pipelines_preview ? 1 : 0
  source                   = "../modules/pipelines"
  name_prefix              = local.name
  account_id               = data.aws_caller_identity.current.account_id
  partition                = data.aws_partition.current.partition
  watcher_package_dir      = var.pipeline_package_dir
  metadata_bucket_name     = aws_s3_bucket.pipeline[0].id
  credential_name          = aws_ssm_parameter.database_url.name
  permissions_boundary_arn = local.boundary
  runtime_enabled          = false
  schedules_enabled        = false
}

output "pipeline_watcher_name" {
  value = try(module.pipelines[0].watcher_name, null)
}

output "pipeline_schedule_group_name" {
  value = try(module.pipelines[0].schedule_group_name, null)
}
