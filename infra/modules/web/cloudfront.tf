# CloudFront in front of S3 (assets) and the two Function URLs, all through Origin Access Control.

resource "aws_cloudfront_origin_access_control" "s3" {
  name                              = "${var.name_prefix}-s3"
  description                       = "${var.name_prefix} assets bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "lambda" {
  name                              = "${var.name_prefix}-lambda"
  description                       = "${var.name_prefix} Function URLs"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Function URL origins receive their own host in Host, so the viewer host is passed in
# x-forwarded-host (used by OpenNext and by Auth.js with trustHost).
resource "aws_cloudfront_function" "forward_host" {
  name    = "${var.name_prefix}-forward-host"
  runtime = "cloudfront-js-2.0"
  comment = "Copy Host to x-forwarded-host"
  publish = true
  code    = file("${path.module}/forward-host.js")
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# Server responses: cached only when Next sends s-maxage (static/ISR pages). The cache key holds the
# headers Next varies RSC responses on; cookies and other headers reach the origin via the origin
# request policy without being part of the key (dynamic pages are sent with no-store).
resource "aws_cloudfront_cache_policy" "server" {
  name        = "${var.name_prefix}-server"
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

resource "aws_cloudfront_cache_policy" "image" {
  name        = "${var.name_prefix}-image"
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

locals {
  server_origin_id = "server"
  image_origin_id  = "image"
  s3_origin_id     = "assets"
  all_methods      = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
}

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2and3"
  price_class     = var.price_class
  comment         = var.name_prefix
  aliases         = var.domain_names

  origin {
    origin_id                = local.s3_origin_id
    domain_name              = aws_s3_bucket.assets.bucket_regional_domain_name
    origin_path              = "/${local.assets_prefix}"
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }

  origin {
    origin_id                = local.server_origin_id
    domain_name              = split("/", aws_lambda_function_url.server.function_url)[2]
    origin_access_control_id = aws_cloudfront_origin_access_control.lambda.id
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 30
    }
  }

  origin {
    origin_id                = local.image_origin_id
    domain_name              = split("/", aws_lambda_function_url.image.function_url)[2]
    origin_access_control_id = aws_cloudfront_origin_access_control.lambda.id
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 30
    }
  }

  # Order matters: the first matching pattern wins.
  ordered_cache_behavior {
    path_pattern             = "_next/image*"
    target_origin_id         = local.image_origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = aws_cloudfront_cache_policy.image.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.forward_host.arn
    }
  }

  ordered_cache_behavior {
    path_pattern             = "_next/data/*"
    target_origin_id         = local.server_origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = local.all_methods
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = aws_cloudfront_cache_policy.server.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.forward_host.arn
    }
  }

  dynamic "ordered_cache_behavior" {
    for_each = local.s3_patterns
    content {
      path_pattern           = ordered_cache_behavior.value
      target_origin_id       = local.s3_origin_id
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["GET", "HEAD", "OPTIONS"]
      cached_methods         = ["GET", "HEAD"]
      compress               = true
      cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id
    }
  }

  default_cache_behavior {
    target_origin_id         = local.server_origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = local.all_methods
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = aws_cloudfront_cache_policy.server.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.forward_host.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.acm_certificate_arn == null
    acm_certificate_arn            = var.acm_certificate_arn
    ssl_support_method             = var.acm_certificate_arn == null ? null : "sni-only"
    minimum_protocol_version       = var.acm_certificate_arn == null ? "TLSv1" : "TLSv1.2_2021"
  }
}
