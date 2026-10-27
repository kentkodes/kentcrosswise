# Persistent essay data belongs to owner/bootstrap state. The normal deployment role intentionally
# cannot change bucket policies/versioning or delete buckets; retain that boundary.
resource "aws_s3_bucket" "pipelines" {
  bucket = "kentcrosswise-pipelines-${var.aws_account_id}"
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "pipelines" {
  bucket = aws_s3_bucket.pipelines.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Metadata objects are rewritten on every run (catalog snapshots, robots latest.json), so without
# expiry each overwrite would keep a noncurrent version forever.
resource "aws_s3_bucket_lifecycle_configuration" "pipelines" {
  bucket = aws_s3_bucket.pipelines.id

  rule {
    id     = "pipelines-meta-noncurrent"
    status = "Enabled"
    filter {
      prefix = "pipelines/meta/"
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.pipelines]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "pipelines" {
  bucket = aws_s3_bucket.pipelines.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "pipelines" {
  bucket                  = aws_s3_bucket.pipelines.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "pipelines" {
  bucket = aws_s3_bucket.pipelines.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

data "aws_iam_policy_document" "pipelines_bucket" {
  statement {
    sid       = "RequireTls"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.pipelines.arn, "${aws_s3_bucket.pipelines.arn}/*"]
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

resource "aws_s3_bucket_policy" "pipelines" {
  bucket     = aws_s3_bucket.pipelines.id
  policy     = data.aws_iam_policy_document.pipelines_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.pipelines]
}

output "pipeline_metadata_bucket" {
  description = "Owner-created private bucket; runtime is restricted to pipelines/meta/."
  value       = aws_s3_bucket.pipelines.id
}
