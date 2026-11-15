-- 0018 (wave 2 hub integrations: Calendar suggestions and web push). Additive.
-- 1. entries.time_zone: the browser's IANA zone of a capture, stored when the capture form sends it.
-- 2. calendar_suggestions: the crm note that produced the suggestion (removed with the note), an all-day flag,
--    the zone of the event and the creation time. One suggestion per crm note (partial unique index), so a
--    retried or repeated route cannot create a second one.
-- 3. inbox_items.notified_at: when a push notification was sent for an item, plus a partial index of open
--    items that were not notified yet.
-- 4. A delete trigger on calendar_suggestions closes the suggestion's open inbox item, so removing a note
--    (which cascades to its suggestion) leaves no open calendar item behind.
-- web_rw already holds table-level SELECT/INSERT/UPDATE/DELETE on these tables (0001), so the new columns and
-- the trigger's UPDATE on inbox_items need no extra grant.

ALTER TABLE entries
  ADD COLUMN time_zone text CHECK (time_zone IS NULL OR length(time_zone) BETWEEN 1 AND 64);

ALTER TABLE calendar_suggestions
  ADD COLUMN crm_note_id uuid REFERENCES crm_notes (id) ON DELETE CASCADE,
  ADD COLUMN all_day boolean NOT NULL DEFAULT false,
  ADD COLUMN time_zone text CHECK (time_zone IS NULL OR length(time_zone) BETWEEN 1 AND 64),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX calendar_suggestions_note_uq ON calendar_suggestions (crm_note_id) WHERE crm_note_id IS NOT NULL;

ALTER TABLE inbox_items ADD COLUMN notified_at timestamptz;
CREATE INDEX inbox_items_unnotified_idx ON inbox_items (created_at) WHERE status = 'open' AND notified_at IS NULL;

CREATE FUNCTION calendar_suggestion_closed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE inbox_items SET status = 'done', resolved_at = now()
   WHERE kind = 'calendar' AND ref_table = 'calendar_suggestions' AND ref_id = OLD.id::text AND status = 'open';
  RETURN OLD;
END $$;

CREATE TRIGGER calendar_suggestions_close_inbox AFTER DELETE ON calendar_suggestions
  FOR EACH ROW EXECUTE FUNCTION calendar_suggestion_closed();
