# E5 design: source registry and scheduled watcher

Status: owner accepted all 14 defaults, 2026-10-27. Tasks 1–7 are built locally on the source-registry branch; discovery/publishing is verified with offline fixtures, with live-source/runtime gates still open. Migration 0008 is owner-approved; no production apply has occurred. Inputs: [SPEC](SPEC.md) (Pipeline, Crawl rules), [DESIGN.md](../DESIGN.md) section 3.3 and the pipelines notes, [OPEN-POINTS](../OPEN-POINTS.md) E4-E7, [SEED-LIST.json](SEED-LIST.json) (300 approved entries). Current evidence and activation holds: [HANDOFF.md](../HANDOFF.md).

Implementation reconciliation: `sources.id` remains UUID with a separate `slug`; pausing uses `paused_by` alongside the existing health values. Gutenberg discovery uses published catalog metadata and approved catalog links, without constructing body-download URLs. English Wikisource's live robots.txt disallows ordinary `/w/api.php` queries under the accepted every-request robots policy. Keep its adapter offline/refusing until a permitted access path is resolved; do not exempt API requests. The owner-selected `/bot` contact page is now published and live-verified; the local default identity is `KentcrosswiseBot/1.0 (+https://kentcrosswise.com/bot)`. Discovery remains disabled pending its separate access/runtime/review gates. These limits supersede the proposed access assumptions below.

## 1. Scope and facts that shape the design

- E5 covers registry, seed-to-source matching, discovery, rate limits, robots and the `essay-urls` event. It does not fetch essay bodies (E6 runner/extractors), validate (E7) or categorize (E8).
- Seed entries carry no URLs (fields: title, author, year, type, evidence, `public_domain_likely`, batch, access, length). Only 63 of 300 are `public_domain_likely: true`. So the first sources reach roughly 20% of the seed list at best; the rest are link-only from day one.
- First sources: Project Gutenberg and Wikisource (public-domain classics). Their discovery is **seed-targeted**: we look up approved seeds in their catalogs, we do not crawl whole sites.
- The existing stack already has most pieces: `sources`, `essay_urls`, `seed_items`, `quarantine` tables (DESIGN 3.3), EventBridge Scheduler, an SQS `essay-urls` queue plus DLQ planned under `pipelines/`, a `pipelines_paused` flag, Lambda outside a VPC (no NAT cost), Neon, private S3. E5 adds columns and one table, not a new service.

## 2. Source registry record

Extends `sources` (additive migration only; a drop/rename would be a critical change).

| Field | Notes |
|---|---|
| `id` (slug), `name`, `base_url` | `gutenberg`, `wikisource-en` |
| `discovery_mode` | `seed_targeted` or `open_feed` (later sources) |
| `discovery` jsonb | `{kind: catalog_csv\|mediawiki_api\|feed\|sitemap\|archive, url, ...}`; kind-specific parameters. Existing `feed_url`/`sitemap_url`/`archive_url` stay for open-feed sources |
| `extractor_id`, `extractor_version` | null until E6 ships one; a source without an extractor can be discovered but its URLs park as `new` |
| `crawl_rules` jsonb | `min_delay_ms`, `max_concurrency` (fixed 1), `daily_request_cap`, `allow_paths`, `user_agent`, `respect_crawl_delay: true`, `robots` `{fetched_at, sha256, status, s3_key}`, `next_fetch_at` (lease for rate limiting) |
| `license_policy` | `pd_only` (default). Anything not provably public domain is not fetched |
| `health` | `ok`, `degraded`, `broken`, plus `paused` (owner/automatic stop) |
| `health_reason`, `consecutive_failures`, `last_checked_at`, `last_ok_at`, `last_discovery_at`, `open_issue` | reason is a code (`robots_disallow`, `feed_unparseable`, `http_5xx`, `blocked_403`), never page content |

Health rules: 1-2 consecutive failures leave `ok`; 3 sets `degraded`; 6 sets `broken` and `paused`. Any `robots_disallow`, 401/403 on content, or paywall/login marker sets `paused` at once and marks affected URLs `link_only`. Restoring needs a successful nightly check; `paused` from robots/login needs the owner.

User-Agent: a descriptive `KentcrosswiseBot/1.0 (+contact URL)` string, identical on every request.

## 3. Mapping seeds to sources (no guessing)

New table `seed_source_links`: `seed_item_id`, `source_id`, `candidate_url`, `candidate_title`, `candidate_author`, `score`, `evidence` jsonb (which fields matched), `status` (`proposed`, `approved`, `rejected`), `reviewed_by`, `reviewed_at`. One approved link per seed; unique on (seed, source, url). Prerequisite: import SEED-LIST.json into `seed_items` as `approved`.

Matching (pure code, deterministic):
1. Normalize both sides: Unicode NFKC, lowercase, strip punctuation, leading articles, subtitles after a colon, and "by/trans." phrases; authors to `surname, given` with a small alias table (checked in, owner-reviewable).
2. Candidates come only from the source catalog (Gutenberg catalog CSV/RDF metadata; Wikisource MediaWiki API search of the Author and main namespaces). No web search, no LLM.
3. Tiers:
   - **A (exact):** normalized title equal and normalized author equal, the work is in a collection page the source labels as the essay itself, `public_domain_likely` is not `false`. Score 1.0.
   - **B (review):** author equal and title similarity >= 0.85 (token-set, Jaro-Winkler), or title equal and author is a known variant. Score 0.85-0.99.
   - **C (drop):** everything else. Not recorded as a candidate, so seeds simply stay link-only.
4. Chapters inside a book (for example one Montaigne chapter) match only when the source exposes a per-chapter URL; otherwise the whole book is not ingested and the seed stays link-only.
5. Translations: the translator and year must be recorded on the link, and a translation is eligible only if the source states it is public domain. A modern translation is link-only.
6. Review: the matcher writes a **metadata-only review table** (seed title/author, candidate URL, candidate title/author, tier, score) as Markdown for the owner or QA; nothing is fetched until a link is `approved`. Tier A may auto-approve only if decision 2 below says so.
7. Rerun-safe: approved or rejected links are never re-proposed or overwritten.

## 4. Watcher mechanics

One Lambda (`pipelines/watcher`), invoked per source by EventBridge Scheduler (daily; hourly is unnecessary for PD archives) with payload `{source_id, mode: discover|check}`. It exits at once if `pipelines_paused` is true or the source is `paused`.

Discovery by kind:
- `catalog_csv` (Gutenberg): download the published catalog metadata (not the site search), cached by ETag; match approved seed links to book IDs; emit URLs for approved links only. Plain-text/HTML book URLs are built from the ID per the documented layout (verify against Gutenberg's robot-access guidance when building).
- `mediawiki_api` (Wikisource): use `api.php` with the maxlag parameter and the User-Agent; look up approved links by page title; read page metadata and revision id; emit the page URL.
- `feed` (RSS/Atom), `sitemap` (including sitemap-index with `lastmod`), `archive` (paginated list page + selector from the registry): later open-feed sources; each URL is canonicalized (scheme, host case, tracking params, fragment, trailing slash) and filtered through `allow_paths`.

Unseen-URL state: `essay_urls` (PK = canonical url) gains `url_hash`, `seed_item_id`, `last_event_at`, `discovery_run_id`. The watcher does `INSERT ... ON CONFLICT DO NOTHING RETURNING` in Neon; only rows actually inserted produce an event. A `new` row with no downstream progress after 24 h is re-emitted by the nightly check (covers a crash between insert and send). Consumers must be idempotent on `url_hash`; SQS standard queue (at-least-once) is enough and a FIFO 5-minute dedupe window would not help.

SQS event (`essay-urls`, JSON, no essay text, under 1 KB):
```
{ "v": 1, "type": "essay_url.discovered", "source_id": "gutenberg",
  "url": "<canonical>", "url_hash": "<sha256 hex>", "seed_item_id": 12 | null,
  "link_id": 88 | null, "hints": {"title": "...", "author": "...", "lang": "en"},
  "discovered_at": "<ISO-8601>", "run_id": "<uuid>", "attempt": 1 }
```
Hints are catalog metadata only. Messages go to the DLQ after 5 receives (same pattern as the orchestrator queue).

Rate limits and robots:
- Per-site lease in Neon: a request proceeds only after `UPDATE sources SET next_fetch_at = now() + delay WHERE id=$1 AND next_fetch_at <= now() RETURNING`; no row means wait. `delay` = max(`min_delay_ms`, robots Crawl-delay, the last `Retry-After`). Defaults: 3 s, one request at a time, 500 requests/day per source. This lease also binds the E6 runner, which uses the same function (shared module in `packages/essays`).
- robots.txt: fetched at the start of each run, cached 24 h (`ETag`/`sha256` in `crawl_rules.robots`, body in S3 for auditing). Parsing per RFC 9309. 404 means allow; 5xx or timeout means treat as disallow for this run (fail closed, retry next run); 401/403 means disallow. Every URL is checked against the cached rules before any request. A rule change that newly disallows an already-ingested URL flags the source for owner review; stored text is not deleted automatically.
- Retries: network errors, 429 and 5xx use exponential backoff with jitter (2, 4, 8 s, max 3 in-run), honoring `Retry-After`; 4xx other than 429 are not retried. After in-run retries the failure counts toward `consecutive_failures`; the URL stays `new` with `attempts` incremented, max 5 before `failed`.
- Hard stops: never send cookies or credentials, never follow a redirect to a login host, never solve or work around bot checks, stop the source on 403.

## 5. Where state lives and cost

| State | Home | Why |
|---|---|---|
| sources, links, essay_urls, health, rate lease | Neon | small, relational, needs transactional claim; a few thousand rows |
| robots.txt copies, catalog snapshot (ETag cached) | private S3 bucket (`pipelines/meta/`) | blobs; the same bucket as essay text but a separate prefix |
| essay text | private S3 (E6) | never in git, CI logs or public endpoints |
| run logs | CloudWatch: URLs, counts, status codes only | no body text |

Cost: Lambda runs seconds a day; SQS and EventBridge usage is far below free tiers; Neon holds well under 1 GB (about 300 seed rows plus a few thousand URL rows); S3 holds tens of MB. A Neon scale-to-zero wake-up per run is acceptable. No new paid service, no NAT, no VPC. The Neon 100 CU-hour limit is not a concern at one short run per source per day. New Terraform lives in `infra/modules/pipelines` (queue, DLQ, bucket prefix, Lambda, schedule); prod Terraform changes are critical and go to the owner inbox.

## 6. Testing (public-domain fixtures only)

- Vitest, no live network in CI. A fake HTTP server serves checked-in fixtures: a trimmed Gutenberg-style catalog CSV (metadata of about 10 public-domain works, no body text), a MediaWiki API JSON sample, tiny RSS/Atom, sitemap and sitemap-index files, paginated archive HTML, and robots.txt variants.
- Cases: robots disallow, wildcard and Crawl-delay, robots 404/5xx/403; 429 with `Retry-After`; redirect to login; duplicate run emits zero events; crash between insert and send then recovery; concurrent invocations respect the lease; canonicalization table; paused flags; health transitions; matcher table tests including near-miss titles that must land in tier B or be dropped, and a translator case.
- A contract test checks the SQS event against its schema (zod) and asserts no field exceeds a size limit, which blocks body text by construction.
- A guard test scans fixtures and logs for non-allowlisted text; fixtures need a recorded PD provenance line.
- One manual smoke run per new source after merge, owner-visible, limited to 3 URLs.

## 7. Failure and quarantine hooks (E6/E7)

- Watcher-level failures update source health. At `degraded` the watcher opens one GitHub issue per source (deduped by `open_issue`) for the scraper-builder with source id, URL, reason code and counts; no content.
- Block signals (robots, 401/403, paywall marker) never open a repair issue; the URL becomes `link_only` and the owner is told in the weekly quality report.
- E6 emits `fetch_failed {url_hash, reason}` back to E5 state (`essay_urls.status`, `attempts`); E7 failures go to `quarantine` with its own issue. Both reference `essay_urls.url` so a repaired extractor can requeue by `status = 'quarantined'`.
- The nightly health check (`mode: check`) fetches robots plus one discovery request per source and writes health; it respects the same rate lease.
- Interfaces E5 exposes: `claimFetchSlot(sourceId)`, `isAllowed(sourceId, url)`, `recordOutcome(url, outcome)`, all in `packages/essays` so E6 cannot bypass the rules.

## 8. Ordered implementation tasks

| # | Task | Size | Done when |
|---|---|---|---|
| 1 | Migration: `sources` columns, `seed_source_links`, `essay_urls` columns; import SEED-LIST into `seed_items` | S | migrate tests pass on a Neon branch; 300 rows imported idempotently |
| 2 | Shared module: URL canonicalizer, robots parser/cache, rate lease, HTTP client (UA, retries, no cookies) | M | fake-server tests cover section 6 robots/retry cases |
| 3 | Registry loader + health state machine | S | transitions tested; paused flags honored |
| 4 | Matcher + review-table generator (seed to catalog) | M | tier tests pass; review table produced with no fetch of essay text |
| 5 | Gutenberg discovery (catalog) | M | emits events only for approved links; rerun emits none |
| 6 | Wikisource discovery (MediaWiki API) | M | same; maxlag handling tested |
| 7 | Event schema + SQS publisher + outbox re-emit sweep | S | contract test; crash-recovery test |
| 8 | Terraform `modules/pipelines` (queue, DLQ, bucket prefix, Lambda, schedule) | M | preview apply/teardown green; prod apply owner-approved |
| 9 | Nightly check + issue opener + weekly report counts | S | degraded source opens exactly one issue |
| 10 | Owner review pass on the match table, then enable schedules with `pipelines_paused` off | S | owner approves links; smoke run of 3 URLs per source |
| 11 | Open-feed discovery kinds (feed, sitemap, archive) | M | fixture tests; deferred until a first open source exists |

Tasks 1-4 can start before E6; 5-7 follow; 11 is not needed for the first two sources.

## 9. Risks

- Low yield: at most about 63 seeds are public domain, and many classics are in books, not stand-alone pages; expect fewer than 63 full-text entries. Mitigation: show counts in the review table, keep link-only first-class.
- Copyright of translations and editorial additions on PD works; Wikisource's per-page licensing varies. Mitigation: `pd_only` policy and recorded translator/year; tier B requires human review.
- Source policy drift (robots, API rules, bot-access guidance). Mitigation: nightly check, fail closed, pause on change.
- Wrong match (same title, different work). Mitigation: no auto-approval of tier B, author required equal, review table.
- Neon cold start or lease contention causing duplicate fetches. Mitigation: lease claim is transactional and E6 uses the same function.
- New dependencies (robots parser, CSV/XML parser) are critical changes. Mitigation: prefer small hand-written parsers or ask the owner to approve names up front.
- Event delivery duplicates. Mitigation: idempotency on `url_hash`.

## 10. Open decisions (each with a proposed default)

1. **Discovery scope for catalog sources.** Default: seed-targeted only (approved links), never ingest a whole catalog.
2. **Auto-approve tier A matches?** Default: yes for tier A only when `public_domain_likely` is true; everything else needs a human review of the table.
3. **Who reviews tier B?** Default: QA drafts a verdict in the review table; the owner confirms in one batch (metadata only).
4. **Queue type for `essay-urls`.** Default: standard SQS with idempotent consumers, not FIFO.
5. **Per-site rate defaults.** Default: 3 s delay, one connection, 500 requests/day; honor stricter robots Crawl-delay.
6. **Gutenberg access method.** Default: published catalog metadata plus direct file URLs by book ID, never the site search; confirm against Gutenberg's current robot guidance before task 5.
7. **Wikisource scope.** Default: English Wikisource only; main namespace pages that are single works; no multi-language in MVP.
8. **Robots fail-closed rule.** Default: 5xx/timeout = disallow for the run; 401/403 = disallow; 404 = allow.
9. **Schedule cadence.** Default: daily discovery per source at off-peak UTC; nightly health check shares that run.
10. **Auto-pause thresholds.** Default: degraded at 3, broken and paused at 6 consecutive failures; block signals pause immediately.
11. **Rule change after ingest.** Default: stop new fetches, keep stored text, flag the owner; no auto-delete.
12. **Review artifact home.** Default: the match review table is committed under `docs/essays/` (metadata only), the live state in Neon.
13. **Dependencies.** Default: write minimal robots and catalog parsers in-repo; request approval for any package before use.
14. **Seed list staleness.** Default: SEED-LIST.json stays frozen; pipeline fills `access`, `length`, translator, dates in Neon, not in the JSON.

## Gutenberg seed matching (commands)

All metadata only; no essay text and no book fetch. Targets other than `--pglite` need `--confirm` for every write.

- `pnpm import-seed-list [--confirm] [db option]`: idempotent import of the 300 seeds in one transaction; prints `seed_items` counts before and after.
- `pnpm register-source [--confirm] [db option]`: inserts the `gutenberg` source row if absent (never edits an existing row); allow_paths are `/ebooks/` and `/cache/epub/feeds/` only. Prints `sources` counts.
- `pnpm match-seeds plan [--from-seed-list] [--catalog-file <csv>] [--out <md>] [db option]`: writes `docs/essays/GUTENBERG-MATCH-REVIEW.md` (provenance header: catalog fetch date, matcher version; columns include seed key, Gutenberg id, QA verdict, Owner decision). Catalog from the file, else one polite fetch of the published CSV. No link rows are written; QA and owner cells already in the file are kept on a re-plan.
- `pnpm match-seeds apply --ref <ref> [--only "<ids>"] [--confirm] [db option]`: reads the committed, owner-confirmed table and stores links by seed key and candidate. `approve`/`reject` in Owner decision sets that status (`owner:<ref>`); a blank tier A auto row is approved as `auto:tier-a` only when the seed is `public_domain_likely`; tier B needs an owner entry. `--only` approves just those Gutenberg ids (others stay proposed). Existing decisions are never changed; an unknown seed key, URL or unapprovable `--only` id aborts with zero writes.
- Trust boundary: the committed, owner-reviewed table is what `apply` trusts; it does not recompute the tier or action cells (only the seed's `public_domain_likely` is re-read from the DB).
- For the smoke always pass `--only`: without it, apply approves every blank-owner tier A auto row.
- With `--only`, owner `reject` rows outside the set are not applied (they stay proposed) and a `reject` inside the set aborts. An approval aimed at an already rejected link aborts (`approve_on_rejected`).

## Link-only essays for seeds (command)

- `pnpm link-seed-essays [--dry-run] [--confirm] [db option]` (owner option b): each approved seed with no essay (no `seed_items.essay_id`, no `essays.seed_item_id`, no `essay_urls.seed_item_id`, no approved `seed_source_links`, so ingest-bound works never get a link card) gets one `kind='link'` essay with no URL, no text and no word count, and one category from its SEED-LIST type (confidence 1, model `seed-list`; no model call). The type is read from the SEED-LIST entry matched by the stored `seed_list_key`; unknown types and seeds with no entry are skipped and counted. One transaction under an advisory lock, with a NOT EXISTS guard per seed; a rerun inserts nothing. `--dry-run` prints the plan and counts, writes nothing, and needs no `--confirm` (its session is read-only). The reader sends link-only essays to their source URL, or to a DuckDuckGo search for the title and author when none is stored. The feed lets link-only essays through the length filter and marks them with a Link badge; recommendations still never include them.

## Gutenberg ingest from the rsync mirror (command)

Plan section 12; the book text never appears in output (ids, counts and fixed codes only).

Run it from the manual `essay-ingest` workflow (`.github/workflows/essay-ingest.yml`, input `book_ids`, environment `essay-ingest`, main only): fetch runs without AWS credentials, then store assumes `kcw-gh-essay-ingest` once the repo variable `AWS_ROLE_ESSAY_INGEST_ARN` is set (before that the job ends after fetch).

- `pnpm essay-ingest --phase fetch --ids "<book ids>" [--dir <path>]`: rsync (through `timeout 300`, no shell, one book at a time, 10 s apart, `rsync.ibiblio.org` then `gutenberg.pglaf.org` on a connection-class failure) of the book's main-collection directory, top-level `*.txt` only, then in-memory extract and validate; prints file names, sizes, verdict and codes. No database, no AWS. Codes: `mirror_unreachable`, `mirror_refused`, `timeout`, `no_files`, `rsync_failed`, `no_usable_text` (only a latin-1 `-8.txt`).
- `pnpm essay-ingest --phase store --ids "<book ids>" --bucket <bucket> [--dir <path>] [--confirm] [db option]`: needs an `approved` Gutenberg link per id (else `not_approved`, nothing written) and `pipelines_paused` false. Valid text: S3 put of `essays/text/<sha256>.txt` first, then one transaction (`essays` row `kind='full'`, `pending_category`; `essay_urls` row set `fetched`). Invalid text: `quarantine` row with reason codes (`missing_start_marker`, `missing_end_marker`, `license_residue`, `bad_characters`, `html_tags`, `too_short`) and `essay_urls` `quarantined`. The same text under another book is `duplicate` (URL fetched, no second row). No file or no UTF-8 file: attempt counted, `failed` after 5. A rerun skips books already `fetched`, `quarantined` or `link_only`.
- Other store-side codes: `no_files`, `no_usable_text`, `not_approved`, `invalid_book_id`, `bucket_required`. A set `pipelines_paused` makes the run throw and exit 1 with nothing written.
- Exit status 1 if any id ends outside `stored`, `duplicate`, `already_processed` (store) or with a fetch code (fetch).

### Categorize phase

`pnpm essay-ingest --phase categorize --ids "<book ids>" [--dir <path>] [--confirm] [db option] [--models-secret <name>]` gives each essay stored as `pending_category` a type and makes it `active`. The text is the local copy the fetch phase already rsynced into `--dir` (no S3 read); its normalized sha256 must equal `essays.text_hash` (else `text_mismatch`, nothing written). The first 2000 words are classified with the ten type ids as labels plus a short description of each, with `DeepseekProvider` alone (DeepSeek V4.1 Flash via the first-party API, model `deepseek-flash`, an alias rather than a dated pin; no fallback provider; retries are the provider's own). The key comes from the secret `kcw/prod/models` (`deepseek_api_key`, required; `deepseek_base_url`, optional, default `https://api.deepseek.com`; `deepseek_model`, optional, default `deepseek-flash`; a missing or blank optional key means the default, and a gateway with the dated id `deepseek/deepseek-v4.1-flash-1017` is selected with these two keys), read through `@kcw/secrets` and never printed. Any answer whose label is one of the ten types is accepted, whatever its confidence (low-confidence rows stay visible in `essay_categories` for review); an unknown label is `provider_error`. One transaction inserts the top type into `essay_categories` (`ON CONFLICT DO NOTHING`) and sets the essay `active`. One line per id: id, code, type, confidence (2 decimals) and the model id the provider returned.

- Codes: `categorized`, `already_processed` (not `pending_category`, or already has a category), `text_mismatch`, `not_stored`, `not_approved`, `no_files`, `no_usable_text`, `provider_error`, `models_unavailable`. Exit status 1 for any code but `categorized` and `already_processed`. A set `pipelines_paused` makes the run throw with nothing done; non-PGlite targets need `--confirm`.
- Workflow: boolean input `categorize` (default false, so paid model calls only when requested) runs this phase after Store with the same role and `--secret kcw/prod/pipeline`.
- IAM: `kcw-gh-essay-ingest` gains `secretsmanager:GetSecretValue` on `kcw/prod/models-??????` (live bootstrap plan: 1 change).
- Deferred: several types per essay, hook, reading minutes, year, `usage_events` rows (`pipeline_rw` has no grant on it).

### Re-extract phase

Workflow boolean input `reextract` (default false; the Store and Categorize steps are skipped when it is set) runs `pnpm essay-ingest --phase reextract --ids "<book ids>" --bucket <bucket> --dir <path> --confirm` with the same role and secret as Store. For a stored essay of a fetched book it re-extracts the local copy with the current extractor, puts the text under `essays/text/<sha256>.txt` and updates `text_hash`, `text_s3_key` and `word_count` of that row. Its id, status, categories, ratings and reading progress are kept. Codes: `reextracted`, `unchanged` (same hash), `not_stored` (no fetched URL or no single full essay for it), `invalid` (nothing changed, no quarantine row), `duplicate` (the new text is another row's), `changed_concurrently`, `no_files`, `no_usable_text`. Exit 1 for any other code. When the run covers every stored full Gutenberg essay and every id is `reextracted` or `unchanged`, the Gutenberg `sources.extractor_version` is set to the current extractor version; otherwise (including a one-book trial run) it is left alone.
