# Kentcrosswise Essays: Spec

Status: approved by the owner, 2026-10-22. Lives at `/essays` inside the hub; see [../hub/SPEC.md](../hub/SPEC.md) for the shared stack and agent system.

## Purpose

A private library of acclaimed essays, classic and modern, for the owner's own reading. The text is never distributed or monetized. Recommendations learn from the owner's ratings, and AI agents keep growing the collection.

## Access

- Owner only.
- Visitors see a demo built from a handful of public-domain essays.

## Reading experience (MVP)

1. **Setup.** The owner picks essay types (multi-select) and lengths, and can change them later.
   - Types: argumentative, critical, comedic, creative/lyric, personal/memoir, philosophical, political, science/nature, cultural, travel.
   - Lengths: Short (<2k words), Medium (2–6k), Long (6k+).
2. **Feed.** Infinite scroll of cards: title, author, year, type, length, reading time, a one-line hook.
3. **Reader.** Opens from a card. Clean typography and a progress bar. Link-only entries open the source instead.
4. **Rating** at the end of each essay:
   - overall, 1–5 stars
   - what worked (multi-select): ideas, prose, argument, humor, emotion, surprise
   - length felt: too long / right / too short
5. **Recommendations.** Filtered by the owner's types and lengths, ranked by similarity to highly rated essays (type, author, era, "what worked" tags). Embedding-based similarity comes later.

## Library

- **Seed list.** An agent drafts ~300 essays from well-known anthologies and "best essays" lists. The owner approves the list before anything is scraped.
- **Entry kinds.** *Full text*: scraped or imported. *Link-only*: paywalled or print-only, with metadata and a source link.
- **Import** of EPUB/PDF files the owner owns: after MVP.

## Pipeline

1. **Source registry.** One record per site: feed/sitemap/archive URL, extractor id, crawl rules, health status.
2. **Watcher.** Generic scheduled code, no AI. Reads each source's feed, sitemap or archive page and emits a "new URL" event to SQS for each unseen URL.
3. **Extractor.** Per-site plain code written by the scraper-builder agent. Outputs clean text plus title, author, date and source.
4. **Validator.** Generic, no AI.
   - Duplicates: exact (normalized-text hash), near (shingling/MinHash), metadata (fuzzy title + author).
   - Text quality: leftover markup, cut-off endings, navigation or ad text, encoding errors, word count out of range, wrong language.
   - Any failure sends the essay to quarantine and opens a GitHub issue for the scraper-builder.
5. **Categorizer.** Jev assigns types with confidence. Below the threshold, or if Jev is down, Haiku 5.5 takes over.
6. **Storage.** Text in a private S3 bucket; metadata, categories and ratings in Neon.

## Crawl rules

- Obey robots.txt and rate-limit every site.
- Never bypass paywalls or logins; those essays become link-only.
- Essay text never goes into the git repo, CI logs or any public endpoint. Tests use public-domain fixtures.

## Agent duties

- Build extractors for new sources; repair broken ones.
- Nightly health check of every source.
- Weekly quality report: new essays added, quarantined, duplicates caught.

## Done means (MVP)

- The approved seed list is processed: every entry is either full text that passes the validator, or link-only.
- No duplicates in the library.
- The owner can set preferences, scroll, read, rate, and see recommendations change.
