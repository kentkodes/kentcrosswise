variable "pipelines_deployed" {
  description = "Opt in only after owner bootstrap and the pipeline credential are ready. Deploys inert resources (runtime and schedules hard-coded off); does not enable discovery. Runtime IAM is built in the module from exact ARNs."
  type        = bool
  default     = false
}

variable "pipeline_package_dir" {
  type    = string
  default = "../../scripts/dist-pipelines"
}

data "aws_caller_identity" "pipeline" {
  count = var.pipelines_deployed ? 1 : 0
}

data "aws_s3_bucket" "pipeline" {
  count  = var.pipelines_deployed ? 1 : 0
  bucket = "kentcrosswise-pipelines-${data.aws_caller_identity.pipeline[0].account_id}"
}

module "pipeline_secrets" {
  count  = var.pipelines_deployed ? 1 : 0
  source = "../modules/secrets"
  names  = ["kcw/prod/pipeline"]
}

module "pipelines" {
  count                = var.pipelines_deployed ? 1 : 0
  source               = "../modules/pipelines"
  name_prefix          = "kcw-prod"
  account_id           = data.aws_caller_identity.pipeline[0].account_id
  watcher_package_dir  = var.pipeline_package_dir
  metadata_bucket_name = data.aws_s3_bucket.pipeline[0].id
  credential_name      = module.pipeline_secrets[0].names[0]
  runtime_enabled      = false
  schedules_enabled    = false
}

output "pipeline_watcher_name" {
  value = try(module.pipelines[0].watcher_name, null)
}
