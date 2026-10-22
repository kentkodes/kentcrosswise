locals {
  dns_records = var.route53_zone_id == null ? {} : merge(
    { for d in var.domain_names : "${d}/A" => { name = d, type = "A" } },
    { for d in var.domain_names : "${d}/AAAA" => { name = d, type = "AAAA" } },
  )
}

resource "aws_route53_record" "alias" {
  for_each = local.dns_records

  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}
