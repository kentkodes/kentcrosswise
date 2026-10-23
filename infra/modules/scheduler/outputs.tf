output "sweeper_function_name" {
  value = aws_lambda_function.sweeper.function_name
}

output "schedule_name" {
  value = aws_scheduler_schedule.sweeper.name
}
