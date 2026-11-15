// Consumer receipts (AR2 slice 1, migration 0011): the logical keys of messages the graph finished,
// as orch_rw. A message that carries a key (a relay delivery id, a console or inbox `message_key`)
// is applied once even when the outbox sends it again after SQS's 5-minute deduplication window.
// A kcw-report message is keyed by its identity; its receipt is written by the report transaction
// (store.ts recordReport) and again, harmlessly, here. Sweep messages have no key and are not recorded.
import type pg from "pg";

export interface ReceiptStore {
  has(key: string): Promise<boolean>;
  /** Idempotent. */
  record(key: string): Promise<void>;
}

export class PgReceiptStore implements ReceiptStore {
  constructor(private readonly pool: Pick<pg.Pool, "query">) {}

  async has(key: string): Promise<boolean> {
    const { rows } = await this.pool.query("SELECT 1 FROM orchestrator_receipts WHERE message_key = $1", [key]);
    return rows.length > 0;
  }

  async record(key: string): Promise<void> {
    await this.pool.query("INSERT INTO orchestrator_receipts (message_key) VALUES ($1) ON CONFLICT (message_key) DO NOTHING", [key]);
  }
}
