output "watcher_name" {
  value = aws_lambda_function.watcher.function_name
}

output "queue_url" {
  value = aws_sqs_queue.essay_urls.url
}

output "queue_arn" {
  value = aws_sqs_queue.essay_urls.arn
}

output "schedule_group_name" {
  value = aws_scheduler_schedule_group.pipelines.name
}

output "schedule_group_arn" {
  value = aws_scheduler_schedule_group.pipelines.arn
}
