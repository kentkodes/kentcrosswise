# Looks up existing Secrets Manager secrets (created empty by infra/bootstrap) and builds a read
# policy for one consumer. Plans fail early if a secret is missing.

terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0"
    }
  }
}

variable "names" {
  description = "Secret names this consumer may read, e.g. [\"kcw/prod/web\"]."
  type        = list(string)
}

data "aws_secretsmanager_secret" "this" {
  for_each = toset(var.names)
  name     = each.value
}

data "aws_iam_policy_document" "read" {
  statement {
    sid       = "ReadSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for s in data.aws_secretsmanager_secret.this : s.arn]
  }
}

output "names" {
  description = "The same names, available only once every lookup succeeded."
  value       = [for n in var.names : data.aws_secretsmanager_secret.this[n].name]
}

output "arns" {
  value = { for n, s in data.aws_secretsmanager_secret.this : n => s.arn }
}

output "read_policy_json" {
  value = data.aws_iam_policy_document.read.json
}
