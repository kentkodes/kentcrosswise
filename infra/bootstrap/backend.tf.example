# Step 2 of docs/runbooks/bootstrap.md: after the first local apply, copy this file to backend.tf,
# then run:
#   terraform init -migrate-state -backend-config="bucket=kentcrosswise-tfstate-<account-id>"
# and commit backend.tf. Do not create backend.tf before the bucket exists.
terraform {
  backend "s3" {
    key          = "bootstrap.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}
