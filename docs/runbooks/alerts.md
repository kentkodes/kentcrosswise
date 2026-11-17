# Runbook: failure alerts (owner)

For the owner. Production failures email you through one SNS topic, `kcw-prod-alerts` (AR8b). Agents and the Liaison may read this and prepare commands; they run none of the **owner-only live steps** below (rule 12 of [INSTRUCTIONS](../agents/INSTRUCTIONS.md)).

Four CloudWatch alarms and the failed-deploy step of `deploy.yml` publish to the topic. The email address lives only in the SNS subscription, never in the repository, Terraform variables or state. Messages carry alarm names, ARNs and the deploy run id and commit, no payload data.

## 1. One-time owner step: subscribe your email

After the deploy that created the topic:

1. AWS console, region us-east-1, SNS, Topics, `kcw-prod-alerts`, Create subscription.
2. Protocol Email, Endpoint your address, Create subscription.
3. Open the confirmation email and click Confirm subscription. The subscription stays "Pending confirmation" until then, and no alert is delivered.

Terraform must never manage this subscription (a test fails if any `.tf` file contains `aws_sns_topic_subscription`).

## 2. Controlled test (owner-only)

Run with the owner's credentials; replace `<account-id>` with the account id from the console:

```
aws sns publish --region us-east-1 --topic-arn arn:aws:sns:us-east-1:<account-id>:kcw-prod-alerts --subject "kcw test alert" --message "test message, no action needed"
```

The email should arrive within a minute. To test the alarm path too, set one alarm to ALARM by hand (it returns to OK at its next evaluation and sends an OK email):

```
aws cloudwatch set-alarm-state --region us-east-1 --alarm-name kcw-prod-orchestrator-dlq-not-empty --state-value ALARM --state-reason "controlled test"
```

## 3. The alarms and the first response

All alarms treat missing data as healthy and notify on both ALARM and OK.

| Alarm | Fires when | First response |
|---|---|---|
| `kcw-prod-orchestrator-dlq-not-empty` | A message is visible in `kcw-prod-orchestrator-dlq.fifo` (5-minute maximum above 0). The orchestrator failed to process an input message `maxReceiveCount` times. | Open the dead-letter queue in the SQS console and read the message (it holds ids and GitHub event fields such as a branch name, no hub text). Check the orchestrator Lambda log group `/aws/lambda/kcw-prod-orchestrator` for the error class. Fix forward, then redrive the message to the input queue or delete it. |
| `kcw-prod-orchestrator-in-oldest` | The oldest message in `kcw-prod-orchestrator-in.fifo` is older than 30 minutes. The orchestrator is not consuming (errors, throttling or a stuck message group). | Check the orchestrator Lambda errors and throttles. Messages of one task are ordered, so one failing message blocks its group until it reaches the dead-letter queue. |
| `kcw-prod-sweeper-failing` | The `kcw-prod-sweeper` Lambda reported errors in two consecutive 15-minute periods. It throws when any part fails or the database is unavailable. | Read `/aws/lambda/kcw-prod-sweeper`. A database error usually means the database is unavailable (see [prod-db.md](prod-db.md)). |
| `kcw-prod-hub-jobs-failing` | At least one scheduled web job (`inbox-push`) logged `[job] <name> failed <ErrorClass>` in one day. A metric filter on `/aws/lambda/kcw-prod-server` counts those lines into `kcw/HubJobFailures`. | Search that log group for `[job]` to see the job and the error class. The job runs again on its next schedule, within 15 minutes. |

A failed deploy is not an alarm: the last two steps of `deploy.yml` run only when the run failed and publish "kcw deploy failed" with the run id and commit. Open that run and follow [release-recovery.md](release-recovery.md) section 3. If the deploy role could not be assumed at all, nothing is published; GitHub's failed-run email is the fallback.

## 4. Recovery objectives

Owner decision (2026-11-17), for one owner with no on-call. Detection is the alarm's own threshold; the objectives start when the email arrives and count waking hours, not a pager. They are targets for the owner's response, not guarantees.

| Failure | Detected within | Contained within | Recovered within | What is at risk meanwhile |
|---|---|---|---|---|
| Agent pipeline: DLQ not empty, input queue older than 30 minutes, sweeper failing | 5 to 35 minutes | 4 hours: set `agents_paused=true` if the cause is not obvious (no new dispatch, nothing merges) | 1 day: fix forward, then redrive or delete the message | Agent tasks only. The public site and the hub keep working. |
| Hub job failing (`inbox-push`) | 1 day (daily sum) | Nothing to contain: the job retries on its own schedule | Before its next scheduled run after the email, or 2 days if the cause is a provider (token or quota) | Delayed push notices. No data loss. |
| Failed deploy (SNS "kcw deploy failed") | the run's end | Immediate: the previous build stays live (build runs before the migration) | Before the next merge: fix forward or revert ([release-recovery.md](release-recovery.md) section 3) | New changes do not ship; a failed migration leaves earlier files of that run applied. |
| Data loss or corruption in the database | when noticed (no alarm) | 1 hour: stop writers ([release-recovery.md](release-recovery.md) section 6 step 1) | Decide inside Neon's restore window (6 hours recorded for the Free plan; verify in the console): restore as a branch, check, cut over | Work after the restore point. Recovery point = the restore timestamp. |

Agents stay paused during any open pipeline alarm. A pipeline alarm that is still open after 1 day, a second failed deploy in a row, or any database restore is recorded in [OPEN-POINTS.md](../OPEN-POINTS.md) with its cause.
