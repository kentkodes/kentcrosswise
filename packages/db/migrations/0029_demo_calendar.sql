-- 0029: the dummy calendar of the public log (slice PL7, DESIGN §4.6 "Calendar"). Owner-critical: new web_public grants.
--
-- The web app (web_rw, apps/web/src/server/demo-calendar.ts) mirrors the calendar suggestions the owner added from
-- published contact notes into the Google Calendar of a separate dummy account, never the owner's. Each mirrored
-- event is stored here as Google holds it: the title after the record's redactor, the times rounded down to the hour
-- (an all-day event stays all-day: midnight UTC of its date to the next), and the Google event id derived from the
-- suggestion id. A row has no foreign key on purpose: it outlives its suggestion or entry until the Google event is
-- removed, and the sync removes both once the record is no longer published.
--
-- demo_calendar is one row: the dummy calendar's id (its account's address, public with the calendar), set at
-- consent, and the outcome code of the last sync that had work to do (shown on /connections).
--
-- web_public reads two views, as with v_public_records (0027): v_public_demo_events lists stored events whose record
-- is published now, with the record's public id (never the entry or suggestion id, never the event id), and
-- v_public_demo_calendar the calendar id for the link to the public calendar. The views run with the owner's
-- rights, so web_public needs no grant on either table.
SET LOCAL lock_timeout = '5s';

CREATE TABLE demo_calendar (
  id                boolean PRIMARY KEY DEFAULT true CHECK (id),
  calendar_id       text CHECK (calendar_id IS NULL OR calendar_id ~ '^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}$'),
  last_sync_at      timestamptz,
  -- a fixed code (demo-calendar.ts SyncOutcome)
  last_sync_outcome text CHECK (last_sync_outcome IS NULL OR last_sync_outcome ~ '^[a-z_-]{1,32}$'),
  CHECK ((last_sync_at IS NULL) = (last_sync_outcome IS NULL))
);
GRANT SELECT, INSERT, UPDATE ON demo_calendar TO web_rw;

CREATE TABLE demo_calendar_events (
  suggestion_id uuid PRIMARY KEY,
  entry_id      uuid NOT NULL,
  -- Google's alphabet for client ids is base32hex (a-v, 0-9); ours is 32 hex characters
  event_id      text NOT NULL UNIQUE CHECK (event_id ~ '^[0-9a-f]{32}$'),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  all_day       boolean NOT NULL,
  start_at      timestamptz NOT NULL CHECK (date_trunc('hour', start_at AT TIME ZONE 'UTC') = start_at AT TIME ZONE 'UTC'),
  end_at        timestamptz NOT NULL CHECK (date_trunc('hour', end_at AT TIME ZONE 'UTC') = end_at AT TIME ZONE 'UTC'),
  mirrored_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK (NOT all_day OR (date_trunc('day', start_at AT TIME ZONE 'UTC') = start_at AT TIME ZONE 'UTC'
                         AND end_at = start_at + interval '1 day'))
);
CREATE INDEX demo_calendar_events_entry_idx ON demo_calendar_events (entry_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON demo_calendar_events TO web_rw;

CREATE VIEW v_public_demo_events AS
  SELECT r.public_id, d.title, d.all_day, d.start_at, d.end_at
    FROM demo_calendar_events d JOIN public_records r ON r.entry_id = d.entry_id
   WHERE r.state = 'published';

CREATE VIEW v_public_demo_calendar AS
  SELECT c.calendar_id FROM demo_calendar c WHERE c.calendar_id IS NOT NULL;

GRANT SELECT ON v_public_demo_events, v_public_demo_calendar TO web_public;
