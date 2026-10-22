output "url" {
  description = "Public URL: the first alias, else the CloudFront domain."
  value       = "https://${length(var.domain_names) > 0 ? var.domain_names[0] : aws_cloudfront_distribution.this.domain_name}"
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.this.domain_name
}

output "distribution_id" {
  value = aws_cloudfront_distribution.this.id
}

output "assets_bucket" {
  value = aws_s3_bucket.assets.id
}

output "server_function_name" {
  value = aws_lambda_function.server.function_name
}

output "server_role_name" {
  value = aws_iam_role.server.name
}

output "build_id" {
  value = local.build_id
}
