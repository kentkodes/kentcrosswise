-- 0027: published records of the public log (slice PL4, DESIGN §4.6). Owner-critical: new web_public grants.
--
-- public_records holds one snapshot per reviewed entry, written by the web app (web_rw) when the owner reviews an
-- entry and on each later verdict (apps/web/src/server/publish.ts). A snapshot is either `published` (the sanitized
-- text from createRecordRedactor and the step lines, each built from fixed codes, kinds, outcomes and numbers only)
-- or `withheld` (no text, no steps; only counted). The table is private: web_public reads two views and nothing else,
-- as with v_public_agent_events (0002) and the v_office_* views (0006). The views run with the owner's rights, so
-- web_public needs no grant on any table.
--
-- v_public_records exposes only published rows: a random public id (never the entry id), the hour captured (rounded),
-- the kind, the sanitized text and the step lines (each with its own rounded hour). v_public_log_counts exposes three
-- counts: published, withheld, and entries awaiting the owner's review (the same filter as review.ts).
SET LOCAL lock_timeout = '5s';

CREATE TABLE public_records (
  entry_id        uuid PRIMARY KEY REFERENCES entries (id) ON DELETE CASCADE,
  public_id       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  state           text NOT NULL CHECK (state IN ('published', 'withheld')),
  -- private: why a record is withheld (a fixed code); never in a view
  withheld_reason text CHECK (withheld_reason IS NULL OR withheld_reason ~ '^[a-z_-]{1,32}$'),
  kind            text NOT NULL CHECK (kind IN ('crm_note', 'diary', 'todo', 'idea', 'agent_request')),
  captured_hour   timestamptz NOT NULL CHECK (captured_hour = date_trunc('hour', captured_hour)),
  body            text CHECK (body IS NULL OR length(body) <= 20000),
  steps           jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(steps) = 'array'),
  first_published timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'published') = (body IS NOT NULL)),
  CHECK ((state = 'withheld') = (withheld_reason IS NOT NULL)),
  CHECK (state = 'published' OR steps = '[]'::jsonb)
);
CREATE INDEX public_records_published_idx ON public_records (captured_hour DESC, public_id) WHERE state = 'published';

GRANT SELECT, INSERT, UPDATE ON public_records TO web_rw;

CREATE VIEW v_public_records AS
  SELECT r.public_id, date_trunc('hour', r.captured_hour) AS captured_hour, r.kind, r.body, r.steps
    FROM public_records r
   WHERE r.state = 'published';

CREATE VIEW v_public_log_counts AS
  SELECT
    (SELECT count(*) FROM public_records WHERE state = 'published') AS published,
    (SELECT count(*) FROM public_records WHERE state = 'withheld') AS withheld,
    (SELECT count(*) FROM entries e
      WHERE e.status = 'routed' AND e.route_kind IS NOT NULL
        AND EXISTS (SELECT 1 FROM agent_events c WHERE c.entry_id = e.id AND c.event_type = 'captured')
        AND NOT EXISTS (SELECT 1 FROM agent_events r WHERE r.entry_id = e.id
              AND (r.event_type IN ('confirmed', 'corrected') OR (r.event_type = 'routed' AND r.detail->>'by' = 'owner')))
    ) AS awaiting_review;

GRANT SELECT ON v_public_records, v_public_log_counts TO web_public;
