# One private bucket: _assets/ (static files, read by CloudFront via OAC and by the image function)
# and _cache/ (ISR cache, read and written by the server function).

resource "aws_s3_bucket" "assets" {
  bucket        = "${var.name_prefix}-assets-${local.account_id}"
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "assets_bucket" {
  statement {
    sid       = "CloudFrontReadsAssets"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.assets.arn}/${local.assets_prefix}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.assets.arn, "${aws_s3_bucket.assets.arn}/*"]
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

resource "aws_s3_bucket_policy" "assets" {
  bucket     = aws_s3_bucket.assets.id
  policy     = data.aws_iam_policy_document.assets_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.assets]
}

resource "aws_s3_object" "assets" {
  for_each = local.asset_files

  bucket       = aws_s3_bucket.assets.id
  key          = "${local.assets_prefix}/${each.value}"
  source       = "${local.assets_dir}/${each.value}"
  etag         = filemd5("${local.assets_dir}/${each.value}")
  content_type = lookup(local.mime_types, lower(try(regex("\\.([^./]+)$", each.value)[0], "")), "application/octet-stream")
  # Hashed build files never change; everything else is revalidated by CloudFront.
  cache_control = startswith(each.value, "_next/static/") ? "public,max-age=31536000,immutable" : "public,max-age=0,s-maxage=31536000,must-revalidate"
}

resource "aws_s3_object" "cache" {
  for_each = local.cache_files

  bucket       = aws_s3_bucket.assets.id
  key          = "${local.cache_prefix}/${each.value}"
  source       = "${local.cache_dir}/${each.value}"
  etag         = filemd5("${local.cache_dir}/${each.value}")
  content_type = "application/json"
}
