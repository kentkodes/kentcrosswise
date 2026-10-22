-- 0001: hub and essays tables, DB roles (DESIGN.md §3.1, §3.3, §3.4).
-- Agent-system tables, the public view and their grants come in 0002 (P2-01).
-- Roles are NOLOGIN group roles; login users (with passwords) are created outside
-- the repo and granted membership, so no credential ever appears in a migration.

-- ---------------------------------------------------------------- roles
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['web_rw', 'web_public', 'orch_rw', 'pipeline_rw', 'migrator'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------- hub
CREATE TABLE entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  source           text NOT NULL CHECK (source IN ('web', 'shortcut')),
  raw_text         text NOT NULL,
  route_kind       text CHECK (route_kind IN ('crm_note', 'diary', 'todo', 'idea', 'agent_request')), -- null = pending
  route_confidence real CHECK (route_confidence BETWEEN 0 AND 1),
  route_model      text,
  routed_by        text CHECK (routed_by IN ('model', 'owner')),
  status           text CHECK (status IN ('routed', 'needs_owner'))
);
CREATE INDEX entries_created_at_idx ON entries (created_at DESC);

CREATE TABLE route_corrections (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id   uuid NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
  from_kind  text NOT NULL CHECK (from_kind IN ('crm_note', 'diary', 'todo', 'idea', 'agent_request')),
  to_kind    text NOT NULL CHECK (to_kind IN ('crm_note', 'diary', 'todo', 'idea', 'agent_request')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(name) > 0),
  aliases    text[] NOT NULL DEFAULT '{}',
  how_known  text,
  birthday   date,
  notes      text,
  tags       text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crm_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    uuid REFERENCES entries (id) ON DELETE SET NULL,
  contact_id  uuid REFERENCES contacts (id) ON DELETE SET NULL,
  body        text NOT NULL,
  link_status text NOT NULL DEFAULT 'none' CHECK (link_status IN ('linked', 'ambiguous', 'none')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_notes_contact_idx ON crm_notes (contact_id);

CREATE TABLE calendar_suggestions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id        uuid REFERENCES entries (id) ON DELETE SET NULL,
  title           text NOT NULL,
  start_at        timestamptz NOT NULL,
  end_at          timestamptz,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'added', 'dismissed')),
  google_event_id text,
  CHECK (end_at IS NULL OR end_at >= start_at)
);

CREATE TABLE diary_entries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id   uuid REFERENCES entries (id) ON DELETE SET NULL,
  body       text NOT NULL,
  written_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX diary_entries_written_at_idx ON diary_entries (written_at);

CREATE TABLE mood_scores (
  diary_entry_id uuid PRIMARY KEY REFERENCES diary_entries (id) ON DELETE CASCADE,
  energy         numeric(4, 3) NOT NULL CHECK (energy BETWEEN 0 AND 1),
  stress         numeric(4, 3) NOT NULL CHECK (stress BETWEEN 0 AND 1),
  happiness      numeric(4, 3) NOT NULL CHECK (happiness BETWEEN 0 AND 1),
  satisfaction   numeric(4, 3) NOT NULL CHECK (satisfaction BETWEEN 0 AND 1),
  sadness        numeric(4, 3) NOT NULL CHECK (sadness BETWEEN 0 AND 1),
  anger          numeric(4, 3) NOT NULL CHECK (anger BETWEEN 0 AND 1),
  anxiety        numeric(4, 3) NOT NULL CHECK (anxiety BETWEEN 0 AND 1),
  gratitude      numeric(4, 3) NOT NULL CHECK (gratitude BETWEEN 0 AND 1),
  sentiment      numeric(4, 3) NOT NULL CHECK (sentiment BETWEEN -1 AND 1),
  model          text NOT NULL,
  scored_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE todos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id   uuid REFERENCES entries (id) ON DELETE SET NULL,
  body       text NOT NULL,
  done       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ideas (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id   uuid REFERENCES entries (id) ON DELETE SET NULL,
  body       text NOT NULL,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE social_accounts (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform IN ('youtube', 'instagram', 'tiktok')),
  handle   text NOT NULL,
  ingest   text NOT NULL DEFAULT 'api' CHECK (ingest IN ('api', 'manual')),
  UNIQUE (platform, handle)
);

CREATE TABLE social_snapshots (
  account_id      uuid NOT NULL REFERENCES social_accounts (id) ON DELETE CASCADE,
  day             date NOT NULL,
  followers       bigint CHECK (followers >= 0),
  views           bigint CHECK (views >= 0),
  followers_exact boolean NOT NULL DEFAULT true,
  UNIQUE (account_id, day)
);

CREATE TABLE projects (
  slug  text PRIMARY KEY CHECK (slug ~ '^[a-z0-9-]+$'),
  title text NOT NULL,
  sort  integer NOT NULL DEFAULT 0
);

CREATE TABLE inbox_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('approval', 'routing', 'calendar', 'contact_match')),
  ref_table   text NOT NULL,
  ref_id      text NOT NULL,
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX inbox_items_open_idx ON inbox_items (created_at) WHERE status = 'open';

CREATE TABLE push_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint   text NOT NULL UNIQUE,
  keys       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- essays
-- Type slugs: essays SPEC "Types"; lengths: Short (<2k words), Medium (2-6k), Long (6k+).
CREATE TABLE essay_prefs (
  id      integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  types   text[] NOT NULL DEFAULT '{}' CHECK (types <@ ARRAY[
            'argumentative', 'critical', 'comedic', 'creative_lyric', 'personal_memoir',
            'philosophical', 'political', 'science_nature', 'cultural', 'travel']::text[]),
  lengths text[] NOT NULL DEFAULT '{}' CHECK (lengths <@ ARRAY['short', 'medium', 'long']::text[])
);

CREATE TABLE sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  base_url        text NOT NULL UNIQUE,
  feed_url        text,
  sitemap_url     text,
  archive_url     text,
  extractor_id    text,
  crawl_rules     jsonb NOT NULL DEFAULT '{}', -- min_delay_ms, allow_paths, robots_cached_at
  health          text NOT NULL DEFAULT 'ok' CHECK (health IN ('ok', 'degraded', 'broken')),
  last_checked_at timestamptz,
  last_ok_at      timestamptz
);

CREATE TABLE essay_urls (
  url           text PRIMARY KEY,
  source_id     uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'fetched', 'quarantined', 'link_only', 'failed')),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

CREATE TABLE seed_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL,
  author        text NOT NULL,
  year          integer,
  suggested_url text,
  list_refs     text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected')),
  essay_id      uuid -- FK added below (essays references seed_items too)
);

CREATE TABLE essays (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('full', 'link')),
  title           text NOT NULL,
  author          text NOT NULL,
  year            integer,
  source_id       uuid REFERENCES sources (id) ON DELETE SET NULL,
  source_url      text,
  word_count      integer CHECK (word_count > 0),
  length_band     text GENERATED ALWAYS AS (
                    CASE
                      WHEN word_count IS NULL THEN NULL
                      WHEN word_count < 2000 THEN 'short'
                      WHEN word_count < 6000 THEN 'medium'
                      ELSE 'long'
                    END) STORED,
  reading_minutes integer CHECK (reading_minutes > 0),
  hook            text,
  text_s3_key     text,
  text_hash       text UNIQUE,
  minhash         integer[],
  language        text,
  status          text NOT NULL DEFAULT 'pending_category'
                    CHECK (status IN ('active', 'quarantined', 'pending_category')),
  seed_item_id    uuid REFERENCES seed_items (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'link' OR (text_hash IS NOT NULL AND text_s3_key IS NOT NULL))
);

ALTER TABLE seed_items
  ADD CONSTRAINT seed_items_essay_id_fkey FOREIGN KEY (essay_id) REFERENCES essays (id) ON DELETE SET NULL;

CREATE TABLE essay_categories (
  essay_id   uuid NOT NULL REFERENCES essays (id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN (
               'argumentative', 'critical', 'comedic', 'creative_lyric', 'personal_memoir',
               'philosophical', 'political', 'science_nature', 'cultural', 'travel')),
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  model      text NOT NULL,
  PRIMARY KEY (essay_id, type)
);

CREATE TABLE quarantine (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  essay_url    text NOT NULL,
  essay_id     uuid REFERENCES essays (id) ON DELETE SET NULL,
  reasons      jsonb NOT NULL,
  github_issue integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

CREATE TABLE ratings (
  essay_id    uuid PRIMARY KEY REFERENCES essays (id) ON DELETE CASCADE,
  stars       smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  worked      text[] NOT NULL DEFAULT '{}'
                CHECK (worked <@ ARRAY['ideas', 'prose', 'argument', 'humor', 'emotion', 'surprise']::text[]),
  length_felt text CHECK (length_felt IN ('too_long', 'right', 'too_short')),
  rated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reading_progress (
  essay_id   uuid PRIMARY KEY REFERENCES essays (id) ON DELETE CASCADE,
  pct        numeric(5, 2) NOT NULL CHECK (pct BETWEEN 0 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quality_reports (
  week   date PRIMARY KEY,
  counts jsonb NOT NULL
);

-- ---------------------------------------------------------------- grants (§3.4)
GRANT USAGE ON SCHEMA public TO web_rw, web_public, orch_rw, pipeline_rw, migrator;
GRANT CREATE ON SCHEMA public TO migrator;

-- web_rw: every app table.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  entries, route_corrections, contacts, crm_notes, calendar_suggestions, diary_entries, mood_scores,
  todos, ideas, social_accounts, social_snapshots, projects, inbox_items, push_subscriptions,
  essay_prefs, sources, essay_urls, seed_items, essays, essay_categories, quarantine, ratings,
  reading_progress, quality_reports
TO web_rw;

-- web_public: nothing here; it gets SELECT on v_public_agent_events only (0002).

-- orch_rw: contact names/aliases for the sanitizer (agent tables and the lg schema in 0002).
GRANT SELECT (id, name, aliases) ON contacts TO orch_rw;

-- pipeline_rw: essays pipeline tables (not ratings/reading progress/prefs, which are owner data).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  sources, essay_urls, seed_items, essays, essay_categories, quarantine, quality_reports
TO pipeline_rw;
