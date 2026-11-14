# Shared, immutable CloudFront building blocks for every preview (AR1). kcw-gh-ci can no longer
# create or update origin access controls or cache policies, so previews look these up by name
# (infra/preview/main.tf) and infra/modules/web creates none of its own. The settings are exactly
# the ones infra/modules/web creates for prod. CloudFront is global; the provider's region is
# irrelevant to where they live.

resource "aws_cloudfront_origin_access_control" "preview_s3" {
  name                              = "kcw-preview-s3"
  description                       = "Shared by every preview: assets bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "preview_lambda" {
  name                              = "kcw-preview-lambda"
  description                       = "Shared by every preview: image Function URL"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_cache_policy" "preview_server" {
  name        = "kcw-preview-server"
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true

    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "whitelist"
      headers {
        items = ["accept", "rsc", "next-router-prefetch", "next-router-state-tree", "next-url", "x-prerender-revalidate"]
      }
    }
    query_strings_config {
      query_string_behavior = "all"
    }
  }
}

resource "aws_cloudfront_cache_policy" "preview_image" {
  name        = "kcw-preview-image"
  min_ttl     = 0
  default_ttl = 86400
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = false
    enable_accept_encoding_gzip   = false

    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "whitelist"
      headers {
        items = ["accept"]
      }
    }
    query_strings_config {
      query_string_behavior = "all"
    }
  }
}

# The OAC data source takes only an id, so previews read the two OAC ids from SSM (kcw-gh-ci has
# read-only access to this path). Cache policies are looked up by name.
resource "aws_ssm_parameter" "preview_s3_oac_id" {
  name  = "/kcw/shared/preview-cloudfront/s3-oac-id"
  type  = "String"
  value = aws_cloudfront_origin_access_control.preview_s3.id
}

resource "aws_ssm_parameter" "preview_lambda_oac_id" {
  name  = "/kcw/shared/preview-cloudfront/lambda-oac-id"
  type  = "String"
  value = aws_cloudfront_origin_access_control.preview_lambda.id
}
