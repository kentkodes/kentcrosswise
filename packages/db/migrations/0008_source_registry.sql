-- E5 source registry (docs/essays/E5-DESIGN.md sections 2-4). Additive only; nothing existing changes.
-- sources.id stays a uuid (essays and essay_urls reference it); the design slug ids live in `slug`.
-- Pausing is paused_by (null = running). sources.health keeps ok/degraded/broken: a pause for a block
-- signal or six failures shows as broken with a reason code.

ALTER TABLE sources
  ADD COLUMN slug                text UNIQUE,
  ADD COLUMN discovery_mode      text NOT NULL DEFAULT 'seed_targeted'
                                   CHECK (discovery_mode IN ('seed_targeted', 'open_feed')),
  ADD COLUMN discovery           jsonb NOT NULL DEFAULT '{}', -- {kind: catalog_csv|mediawiki_api|feed|sitemap|archive, url, ...}
  ADD COLUMN extractor_version   text,
  ADD COLUMN license_policy      text NOT NULL DEFAULT 'pd_only' CHECK (license_policy IN ('pd_only')),
  ADD COLUMN health_reason       text, -- a code (robots_disallow, http_5xx, ...), never page content
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  ADD COLUMN paused_by           text CHECK (paused_by IN ('owner', 'failures', 'block')), -- null = not paused
  ADD COLUMN last_discovery_at   timestamptz,
  ADD COLUMN open_issue          integer,
  ADD COLUMN next_fetch_at       timestamptz, -- rate-limit lease: a request may start once this has passed
  ADD COLUMN request_day         date,        -- UTC day of request_count
  ADD COLUMN request_count       integer NOT NULL DEFAULT 0 CHECK (request_count >= 0);

ALTER TABLE essay_urls
  ADD COLUMN url_hash         text UNIQUE, -- sha256 hex of the canonical url
  ADD COLUMN seed_item_id     uuid REFERENCES seed_items (id) ON DELETE SET NULL,
  ADD COLUMN link_id          uuid, -- FK added below (seed_source_links is created after)
  ADD COLUMN last_event_at    timestamptz,
  ADD COLUMN discovery_run_id uuid;

-- Seed list import (docs/essays/SEED-LIST.json). seed_list_key makes the import idempotent.
ALTER TABLE seed_items
  ADD COLUMN seed_list_key        text UNIQUE, -- sha256 of "title|author" as listed
  ADD COLUMN category_hint        text,
  ADD COLUMN evidence             text CHECK (evidence IN ('direct', 'weak')),
  ADD COLUMN public_domain_likely boolean, -- null = unknown
  ADD COLUMN batch                text,
  ADD COLUMN access               text NOT NULL DEFAULT 'unchecked',
  ADD COLUMN length               text NOT NULL DEFAULT 'unchecked';

CREATE TABLE seed_source_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seed_item_id     uuid NOT NULL REFERENCES seed_items (id) ON DELETE CASCADE,
  source_id        uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  candidate_url    text NOT NULL,
  candidate_title  text NOT NULL,
  candidate_author text NOT NULL,
  translator       text,
  translation_year integer,
  tier             text NOT NULL CHECK (tier IN ('A', 'B')),
  score            real NOT NULL CHECK (score BETWEEN 0 AND 1),
  evidence         jsonb NOT NULL DEFAULT '{}', -- which fields matched
  status           text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
  reviewed_by      text,
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seed_item_id, source_id, candidate_url)
);
-- One approved link per seed.
CREATE UNIQUE INDEX seed_source_links_one_approved ON seed_source_links (seed_item_id) WHERE status = 'approved';

ALTER TABLE essay_urls
  ADD CONSTRAINT essay_urls_link_id_fkey FOREIGN KEY (link_id) REFERENCES seed_source_links (id) ON DELETE SET NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON seed_source_links TO web_rw, pipeline_rw;
