# Orchestrator and webhook relay functions (arm64). Code comes from a directory with index.mjs
# exporting `handler` (infra/prod: the `pnpm build-lambdas` output); null deploys the stubs in stub/.

# ---------- orchestrator (SQS FIFO consumer) ----------

data "archive_file" "orchestrator" {
  type             = "zip"
  output_file_mode = "0644"
  source_dir       = local.orchestrator_package_dir
  output_path      = "${local.zip_dir}/${local.orchestrator_name}.zip"
}

resource "aws_cloudwatch_log_group" "orchestrator" {
  name              = "/aws/lambda/${local.orchestrator_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "orchestrator" {
  name               = local.orchestrator_name
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "orchestrator" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.orchestrator.arn}:*"]
  }

  statement {
    sid       = "ConsumeInputQueue"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.input.arn]
  }

  dynamic "statement" {
    for_each = length(local.orchestrator_secret_arns) > 0 ? [1] : []
    content {
      sid       = "ReadOwnSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.orchestrator_secret_arns
    }
  }
}

resource "aws_iam_role_policy" "orchestrator" {
  name   = local.orchestrator_name
  role   = aws_iam_role.orchestrator.id
  policy = data.aws_iam_policy_document.orchestrator.json
}

resource "aws_lambda_function" "orchestrator" {
  function_name    = local.orchestrator_name
  role             = aws_iam_role.orchestrator.arn
  filename         = data.archive_file.orchestrator.output_path
  source_code_hash = data.archive_file.orchestrator.output_base64sha256
  handler          = "index.handler"
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  memory_size      = var.orchestrator_memory_mb
  timeout          = var.orchestrator_timeout_s

  environment {
    # LangSmith (research/apis.md §6): LANGCHAIN_CALLBACKS_BACKGROUND=false makes traces flush before
    # the function freezes. LANGSMITH_API_KEY is not set here: the code reads langsmith_api_key from
    # its models secret at cold start (D9).
    variables = merge(var.orchestrator_environment, {
      LANGSMITH_TRACING              = tostring(var.langsmith_tracing)
      LANGCHAIN_CALLBACKS_BACKGROUND = "false"
      LANGSMITH_PROJECT              = coalesce(var.langsmith_project, local.orchestrator_name)
    })
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.orchestrator.name
  }

  depends_on = [aws_iam_role_policy.orchestrator]
}

# DESIGN §1: batch size 1, one thread step per invocation. Partial batch responses let the handler
# return a failed message to the queue without an exception; after max_receive_count deliveries
# it moves to the DLQ.
resource "aws_lambda_event_source_mapping" "orchestrator" {
  event_source_arn        = aws_sqs_queue.input.arn
  function_name           = aws_lambda_function.orchestrator.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
}

# ---------- webhook relay (public Function URL) ----------

data "archive_file" "relay" {
  type             = "zip"
  output_file_mode = "0644"
  source_dir       = local.relay_package_dir
  output_path      = "${local.zip_dir}/${local.relay_name}.zip"
}

resource "aws_cloudwatch_log_group" "relay" {
  name              = "/aws/lambda/${local.relay_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "relay" {
  name               = local.relay_name
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "relay" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.relay.arn}:*"]
  }

  statement {
    sid       = "EnqueueToOrchestrator"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.input.arn]
  }

  dynamic "statement" {
    for_each = length(local.relay_secret_arns) > 0 ? [1] : []
    content {
      sid       = "ReadOwnSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.relay_secret_arns
    }
  }
}

resource "aws_iam_role_policy" "relay" {
  name   = local.relay_name
  role   = aws_iam_role.relay.id
  policy = data.aws_iam_policy_document.relay.json
}

resource "aws_lambda_function" "relay" {
  function_name    = local.relay_name
  role             = aws_iam_role.relay.arn
  filename         = data.archive_file.relay.output_path
  source_code_hash = data.archive_file.relay.output_base64sha256
  handler          = "index.handler"
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  memory_size      = var.relay_memory_mb
  timeout          = var.relay_timeout_s

  environment {
    # Read by agents/webhook-relay/src/lambda.ts (configFromEnv).
    variables = merge(var.relay_environment, {
      KCW_WEBHOOK_SECRET_NAME      = var.relay_webhook_secret_name
      KCW_RELAY_DB_SECRET_NAME     = var.relay_db_secret_name
      KCW_ORCHESTRATOR_QUEUE_URL   = aws_sqs_queue.input.url
      KCW_RELAY_ALLOWED_SENDER_IDS = join(",", [for id in var.relay_allowed_sender_ids : format("%d", id)])
    })
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.relay.name
  }

  depends_on = [aws_iam_role_policy.relay]
}

# Public (AuthType NONE): GitHub cannot sign webhook deliveries with SigV4. The relay authenticates
# every request itself by verifying X-Hub-Signature-256 with kcw/github/webhook-secret (DESIGN §1,
# P2-05) before doing anything else; the stub answers 503 without reading anything.
resource "aws_lambda_function_url" "relay" {
  function_name      = aws_lambda_function.relay.function_name
  authorization_type = "NONE"
  invoke_mode        = "BUFFERED"
}

# Ordering: the Function URL create (AuthType NONE) adds its own permission statements without the
# provider's per-function lock, so these wait for it (same race as the web server URL, see
# infra/modules/web/lambda.tf). Only the apply order changes.
resource "aws_lambda_permission" "relay_url" {
  statement_id           = "PublicInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.relay.function_name
  principal              = "*"
  function_url_auth_type = "NONE"

  depends_on = [aws_lambda_function_url.relay]
}

resource "aws_lambda_permission" "relay_invoke" {
  statement_id             = "PublicInvokeFunctionViaUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.relay.function_name
  principal                = "*"
  invoked_via_function_url = true

  depends_on = [aws_lambda_function_url.relay]
}
