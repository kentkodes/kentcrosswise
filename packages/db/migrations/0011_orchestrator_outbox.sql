-- 0011 (AR2 slice 1): database-to-SQS outbox and consumer receipts (DESIGN §4.3).
-- An accepted orchestrator input (a relay delivery, a console task, an owner decision) is committed
-- to orchestrator_outbox in the same transaction as its claim or mutation, then sent to
-- orchestrator-in; the sweeper sends rows that are still unsent. orchestrator_receipts records the
-- messages the consumer finished, by logical message key, so a resend after SQS's 5-minute
-- deduplication window is dropped instead of applied twice. Additive, no foreign keys.
-- Grants match exactly the queries each role runs (checked on PGlite: packages/db/test/outbox.test.ts
-- runs them as members). Column SELECT covers every column read in WHERE, RETURNING or ON CONFLICT
-- (0005); INSERT and UPDATE are per column, so id, created_at, attempts and next_attempt_at keep
-- their defaults for the writers.
--   relay_rw: WITH c AS (INSERT INTO inbound_events ... ON CONFLICT DO NOTHING RETURNING delivery_id)
--               INSERT INTO orchestrator_outbox (message_key, group_id, body) SELECT ... FROM c RETURNING id
--             UPDATE orchestrator_outbox SET sent_at = now() WHERE id = $1 AND sent_at IS NULL
--   web_rw:   INSERT INTO orchestrator_outbox (message_key, group_id, body) VALUES ...
--             UPDATE orchestrator_outbox SET sent_at = now() WHERE message_key = $1 AND sent_at IS NULL
--   orch_rw:  the sweeper's drain: SELECT unsent rows, mark sent, record an attempt and its error;
--             the consumer's receipts: SELECT, INSERT ... ON CONFLICT DO NOTHING
-- relay_rw loses DELETE on inbound_events: the claim is no longer released after a failed send,
-- the outbox row delivers it instead.
-- The REVOKE needs a lock on inbound_events (every relay delivery writes it); like 0007 and 0010 it
-- fails fast instead of queueing behind writers. The runner wraps each file in its own BEGIN, so
-- SET LOCAL ends with it.
SET LOCAL lock_timeout = '5s';

CREATE TABLE orchestrator_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_key text NOT NULL UNIQUE CHECK (length(message_key) BETWEEN 1 AND 128),
  group_id text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);
CREATE INDEX orchestrator_outbox_unsent ON orchestrator_outbox (id) WHERE sent_at IS NULL;

CREATE TABLE orchestrator_receipts (
  message_key text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

GRANT INSERT (message_key, group_id, body), SELECT (id, sent_at), UPDATE (sent_at)
  ON orchestrator_outbox TO relay_rw;
GRANT INSERT (message_key, group_id, body), SELECT (message_key, sent_at), UPDATE (sent_at)
  ON orchestrator_outbox TO web_rw;
GRANT SELECT (id, message_key, group_id, body, created_at, sent_at, attempts, next_attempt_at),
      UPDATE (sent_at, attempts, next_attempt_at, last_error)
  ON orchestrator_outbox TO orch_rw;
GRANT SELECT, INSERT ON orchestrator_receipts TO orch_rw;

REVOKE DELETE ON inbound_events FROM relay_rw;
