# Own module for the OpenNext v4 output (D14). The layout it reads is the "OpenNext output contract"
# in AGENTS.md, enforced at build time by scripts/build-web.ts.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.region

  assets_dir = "${var.artifact_dir}/assets"
  cache_dir  = "${var.artifact_dir}/cache"
  zip_dir    = "${path.root}/.terraform/kcw-web"
  build_id   = trimspace(file("${local.assets_dir}/BUILD_ID"))

  assets_prefix = "_assets"
  cache_prefix  = "_cache"

  asset_files = fileset(local.assets_dir, "**")
  cache_files = fileset(local.cache_dir, "**")

  # Files and directories from public/ sit at the top level of assets/ next to _next/ and BUILD_ID.
  # Each gets its own S3 behaviour; everything else goes to the server function.
  public_files = [for f in fileset(local.assets_dir, "*") : f if f != "BUILD_ID"]
  public_dirs = distinct([
    for f in local.asset_files : split("/", f)[0]
    if length(split("/", f)) > 1 && split("/", f)[0] != "_next"
  ])
  s3_patterns = concat(["_next/*", "BUILD_ID"], local.public_files, [for d in local.public_dirs : "${d}/*"])

  mime_types = {
    avif        = "image/avif"
    cache       = "application/json"
    css         = "text/css; charset=utf-8"
    gif         = "image/gif"
    html        = "text/html; charset=utf-8"
    ico         = "image/x-icon"
    jpeg        = "image/jpeg"
    jpg         = "image/jpeg"
    js          = "text/javascript; charset=utf-8"
    json        = "application/json"
    map         = "application/json"
    mjs         = "text/javascript; charset=utf-8"
    otf         = "font/otf"
    png         = "image/png"
    svg         = "image/svg+xml"
    ttf         = "font/ttf"
    txt         = "text/plain; charset=utf-8"
    webmanifest = "application/manifest+json"
    webp        = "image/webp"
    woff        = "font/woff"
    woff2       = "font/woff2"
    xml         = "application/xml"
  }

  secret_arns = [
    for n in var.secret_names : "arn:${local.partition}:secretsmanager:${local.region}:${local.account_id}:secret:${n}-??????"
  ]
  ssm_parameter_arns = [
    for n in var.ssm_parameter_names : "arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter/${trimprefix(n, "/")}"
  ]

  server_name       = "${var.name_prefix}-server"
  image_name        = "${var.name_prefix}-image"
  revalidation_name = "${var.name_prefix}-revalidation"
}

check "certificate_with_aliases" {
  assert {
    condition     = length(var.domain_names) == 0 || var.acm_certificate_arn != null
    error_message = "domain_names needs acm_certificate_arn (us-east-1)."
  }
}
