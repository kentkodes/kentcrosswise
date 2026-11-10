# Finance: Sure, finance agent and gated crypto trading

Status: DESIGN ONLY, drafted 2026-11-10 from the owner's decisions. No implementation starts until the Kentcrosswise MVP is complete; this document does not change the accepted MVP delivery order (office acceptance, one essay source, essay reader, capture/routing, remaining hub/social/inbox, demos/X-ray/final acceptance). It extends [DESIGN.md](../DESIGN.md) and the [hub spec](../hub/SPEC.md). Adding the Finance tab changes the hub SPEC, a critical change that needs the owner's approval when implemented. Claims about Sure, Robinhood and prices that were not read or verified are marked **unverified** and collected in section 10.

## 1. Purpose

Give the owner a private personal-finance app (Sure, self-hosted), phone access from the hub, a read-only agent that answers questions about the owner's finances, and a tightly gated way to place crypto orders. Everything stays private: the repo, the public feed and public endpoints never see finance data.

## 2. Scope and non-goals

In scope: Sure run unmodified on its own AWS host; Google sign-in; a Finance tab in the hub; manual CSV import, then SimpleFIN; Sure's built-in assistant using Anthropic; a read-only LangGraph agent `agents/finance`; a trade executor for crypto through Robinhood's official Crypto Trading API, every order approved by the owner.

Non-goals (decided): Sure code changes; a native app or an iframe; a native hub card from Sure's API; Plaid; spending caps and symbol allowlists (the owner sets values per order); other brokers; **stock/ETF/options trading**. Reason for the last: the only official Robinhood API found is the Crypto Trading API, and no official API for stocks, ETFs or options was found. Unofficial libraries and scraping are rejected because of account and ToS risk (ToS text not read). Revisit only if the owner names another broker with an official API.

## 3. Architecture

```
 iPhone / browser
   |                                   |
   | hub (Projects > Finance tab = link)| finance.kentcrosswise.com (HTTPS, Google OIDC, MFA)
   v                                   v
 Next.js web (existing) ----------> Route 53 A record -> EC2 host (us-east-1, Docker compose)
   |  console, inbox, approvals          Caddy (TLS) -> web, worker, db (Postgres 16), redis, backup
   |                                     volumes snapshotted; backup profile -> private S3
   |
   |  finance question (SQS orchestrator-in, type finance.question)
   v
 Orchestrator Lambda (routes only) ---> Finance agent Lambda (Haiku 5.5)
                                          reads Sure REST API with a read-only key
                                          writes proposals only (finance_rw), no trade key
   |
   |  propose_order -> trade_orders (pending) + inbox approval card
   v
 Owner approves exact payload in hub inbox -> SQS trade-in -> Trade executor Lambda
                                          -> Robinhood Crypto Trading API (Ed25519-signed)
 Secrets Manager: kcw/prod/finance, kcw/prod/finance-agent, kcw/prod/trade (readers differ)
```

## 4. New dependencies

| What | Why | Approval |
|---|---|---|
| Sure (`ghcr.io/we-promise/sure`, AGPLv3), run unmodified | The finance app itself | Critical (new service) |
| One always-on EC2 instance + EBS + Elastic IP + snapshots, new Terraform module `infra/modules/finance` | Sure needs Postgres, Redis and a worker; cannot run on Lambda or Neon | Critical (new paid service, new infra) |
| Caddy container on the host | Automatic HTTPS without an ALB (an ALB would cost more, unverified) | Critical (new service) |
| Private S3 bucket for Sure backups | Off-host backups | Critical (infra create) |
| Three Secrets Manager secrets (section 5) | Own secrets, per-reader IAM (D19) | Critical (secrets) |
| Google OAuth client for Sure (separate from the hub's) | OIDC sign-in | Owner action in Google console |
| Anthropic API key for Sure's assistant (separate key, spend limit if available) | Built-in assistant | Owner action |
| SimpleFIN Bridge (after CSV) | Bank sync; paid, price **unverified** | Critical (new paid service), P1.5 |
| `agents/finance` Lambda, `trade-in` SQS + DLQ, trade-executor Lambda | Agent and gated trading | Critical (infra, migration) |
| New tables and DB roles (`trade_orders`, `trade_events`, `finance_answers`, roles `finance_rw`, `trade_rw`) | Proposals, audit, answers | Critical (migration, additive only) |
| New npm packages | None planned: Ed25519 signing uses `node:crypto`; Sure is called with `fetch` | Not needed |

Rough monthly cost, **unverified**: t3.small-class instance about 15 USD, 30 GB EBS about 3 USD, Elastic IP about 4 USD, snapshots and S3 about 1-2 USD, three secrets about 1.20 USD, Anthropic usage separate. Total roughly 20-30 USD per month before SimpleFIN and AI usage. A smaller Lightsail plan may be cheaper (unverified); EC2 is chosen because the host can use an instance role for S3 and Secrets Manager with no long-lived keys.

## 5. Hosting and security

- **Host:** EC2 (x86, 2 GB RAM, so Sure's AI use fits; Sure needs about 512 MB, about 1 GB with AI), Amazon Linux, Docker compose with `web`, `worker`, `db`, `redis`, `backup` and Caddy. x86 avoids an unverified arm64 image question.
- **Network:** security group allows only 80 and 443 from the internet (Caddy redirects 80 to 443). No SSH; administration through SSM Session Manager. Postgres and Redis listen only on the compose network. The host uses the default VPC, with no NAT.
- **Sign-in:** Google OIDC restricted to the owner's allowlisted email (the same email as the hub's `owner_email`, never written in the repo), MFA on, `ONBOARDING_STATE=closed` set as soon as the owner account exists, `RAILS_ASSUME_SSL=true`. If Sure's OIDC cannot restrict by email, the closed onboarding state plus a single existing user is the control (verify, section 10).
- **Secrets** (names follow the `kcw/prod/*` convention):

| Secret | Keys | Read by |
|---|---|---|
| `kcw/prod/finance` | secret_key_base, postgres_password, oidc_client_id, oidc_client_secret, anthropic_api_key | the finance host instance role, at boot |
| `kcw/prod/finance-agent` | sure_api_key (read-only), db_url (role `finance_rw`) | finance agent Lambda |
| `kcw/prod/trade` | robinhood_api_key, ed25519_private_key, db_url (role `trade_rw`) | trade-executor Lambda only |

  `SECRET_KEY_BASE` and the DB password are generated by the owner; the compose defaults are public and must not be used. At boot a script writes the compose environment file from the secret to a root-only tmpfs path. The finance agent also reads `anthropic_api_key` from `kcw/prod/models`.
- **Backups:** EBS volume snapshots daily through a lifecycle policy (retain 14), plus Sure's backup profile writing to a private S3 bucket (versioned, encrypted, public access blocked, 30-day lifecycle). A restore is rehearsed once in P1.
- **Updates:** compose pins the image to the digest of the `stable` tag taken in P0, not `latest`. An update is a deliberate change (owner-approved, a snapshot first), at most monthly. OS security patches apply automatically. Whether a numbered release tag exists is unverified.
- **AGPL note:** Sure is unmodified and used privately by one person, so there is no distribution and no source offer to make. If it is ever modified or opened to other users, AGPL section 13 (offer source to network users) applies. This is the architect's reading, not legal advice.

## 6. Phone access

The hub's Projects tabs (SPEC item 6) gain a Finance tab next to Essays: a `projects` row whose link opens `https://finance.kentcrosswise.com` in a new browser tab. No iframe (Sure's cookies, framing headers and OIDC redirects make it fragile; unverified, and not worth testing). The owner can also add the Sure address to the iPhone Home Screen on its own; whether Google sign-in completes inside a Home Screen web app is unverified, with the fallback of signing in once in Safari. A native hub card fed by Sure's API is out of scope.

## 7. Finance agent

- **Fit problem, stated honestly:** the orchestrator today is a task state machine for software work: plan, GitHub issue, dispatch Actions, PR loop, merge-rules. A finance question has none of that. Decision: the orchestrator only routes. A SQS message `{type: "finance.question", task_id, thread_id, text}` makes the handler skip the planner, the title writer and GitHub entirely and forward the message to the finance agent Lambda (async invoke). The orchestrator gains no finance data access and no finance secrets. The graph/state machine is not reused; the thread id is only for dedupe and correlation.
- **Entry points:** boss console (P2). A `finance_question` route in the capture router (new `route_kind` value) is deferred until the console path works.
- **Data access:** Sure's REST API (or its MCP server, if it covers something REST does not; unverified) with a read-only API key from `kcw/prod/finance-agent`. Plain `fetch`, no new package. The agent cannot create or change anything in Sure.
- **Model:** Haiku 5.5 (configurable, D13). Phase 1 is read-only Q&A.
- **Task record:** a `tasks` row with `is_private = true` forced, owner text = the question. The answer goes to `finance_answers` (task_id, answer, created_at) in the private Neon DB and is shown in the console. The public feed shows only `Private task`.
- **Privacy rules:** finance data never reaches a public endpoint, the repo, GitHub issues or logs. The agent Lambda logs counts and status only. **LangSmith:** the orchestrator traces by default (`LANGSMITH_TRACING=true`); a trace would copy transactions and balances to a third party. Decision: the finance Lambda runs with tracing off. Open point 2 covers whether to accept even that.
- **Prompt injection:** transaction descriptions are untrusted text. Mitigation: the agent has no trade key and no send tool, and every order needs the owner's approval of the exact payload (section 8).

## 8. Trading (crypto only, owner-gated)

**Verified by the Liaison (docs.robinhood.com/crypto/trading, read 2026-11-10):** the official API is the Crypto Trading API: US-only; keys created in crypto account settings on web classic; Ed25519 key pair; headers `x-api-key`, `x-signature`, `x-timestamp` (timestamp valid 30 s; signature over api key + timestamp + path + method + body); base `https://trading.robinhood.com`; v1 (no fee tiers) and v2 (fee tiers, `account_number` parameter); endpoints for accounts, holdings, trading pairs, best bid/ask, estimated price, place/cancel/get orders; `client_order_id` (UUID) for idempotency; order types market, limit, stop_loss, stop_limit; 100 requests/min per account (burst 300). No sandbox or paper mode was seen. Use v2 by default (fee tiers), unless the owner's account is only served by v1 (unverified).

**Guardrails (owner's choice):** the agent never places an order on its own. Every order needs the owner's explicit approval in the hub inbox before it is sent. No allowlist and no spending caps: the owner sets the values per order.

**Flow:**
1. A proposal comes from the owner (console form) or from the finance agent's `propose_order` tool. The tool can only insert a `pending` row in `trade_orders` (role `finance_rw` has no other trade access).
2. The executor's quote step (it alone holds the key) fills the estimated price from the read-only price endpoints, and creates the inbox approval (`approvals`, new kind `trade_order`, push notification).
3. The card shows exactly what will be sent: symbol, side, type, quantity or amount, limit/stop prices if any, estimated price, and the expiry time. Approval is bound to the SHA-256 of the canonical request payload (path, method, body incl. `client_order_id`), stored at proposal time. Expiry is 10 minutes.
4. Approve in the inbox enqueues `{order_id}` to SQS `trade-in` (standard queue, one try: `maxReceiveCount` 1, then the DLQ, so a message is never redelivered into a second send).
5. The **trade executor Lambda** (`kcw-prod-trade-executor`, outside a VPC) is the only holder of the trading key, and runs outside the agent so the Q&A agent cannot trade. Immediately before sending it re-checks: status is `approved`, not expired, payload hash matches, `agents_paused` is false, order not already `sending`/`sent`. Then it sets `sending` in one transaction, signs and sends. Any ambiguity (timeout, 5xx) is not retried automatically: the order goes to `unknown`, an inbox item is created, and the owner checks through the order-lookup endpoint (lookup by `client_order_id` is unverified; the Robinhood app is the fallback).
6. **Pause all agents** blocks sending (the check above). An order approved while paused expires on its 10-minute timer, so it can never fire after unpausing; the owner re-proposes.
7. **Audit:** append-only `trade_events` (proposed, quoted, approved, rejected, expired, blocked_paused, sending, sent, error, unknown) with the payload hash and the Robinhood response; no key material. Role `trade_rw` gets INSERT on `trade_events`, SELECT/UPDATE on `trade_orders` and SELECT on `system_flags`, nothing else. Cancelling is done by the owner in Robinhood's app; no cancel tool in this design.

**First-order test plan (no paper mode):** (a) signed GET calls only (accounts, best bid/ask, estimated price, trading pairs) to prove signing and the 30 s clock window; (b) read the pair's minimum order size from the trading-pairs data (field names unverified); (c) with the owner watching, one limit order at the smallest allowed size, priced well away from market so it should not fill, approved through the real card; confirm send, lookup and an owner-side cancel in the app; (d) one smallest market order that fills, owner watching and ready to stop; (e) negative tests on the real path with no order sent: expired card, tampered payload hash, paused flag, double approve. Enable the real queue only after (a)-(e).

## 9. Phases

| Phase | Work | Done when |
|---|---|---|
| P0 local trial | Run Sure locally with fake data. Read Sure's `docs/hosting/ai.md`, `mcp.md`, `oidc.md` and `api/openapi.yaml` (not yet read). Check: Anthropic through Sure's provider config, OIDC email restriction, API key scopes (read-only possible?), CSV import, SimpleFIN support, image digest of `stable`, arm/x86 | Verification items 1-6 answered in this file; instance size confirmed |
| P1 host | Terraform module, compose, Caddy, secrets, S3 backup + snapshots, Google OIDC, MFA, `ONBOARDING_STATE=closed`, Finance tab, CSV import, restore rehearsal. Then SimpleFIN | Owner signs in from iPhone; a restore from backup works; only 80/443 reachable; owner approves the cost |
| P2 agent | Migration (`finance_answers`, `finance_rw`), `finance.question` route, finance Lambda, console form | A console question returns an answer from Sure data; nothing in logs, traces or the feed shows finance data |
| P3 trading | Migration (`trade_orders`, `trade_events`, `trade_rw`, approval kind), executor, `trade-in`, approval card, test plan of section 8 | Test plan (a)-(e) passes with the owner present |

All phases begin only after MVP completion. Each is a separate owner-approved change; infra and migrations are critical.

## 10. Verification items (all unverified until checked)

1. Sure's MCP and REST API: coverage, read-only key support, auth header, rate limits (P0, `mcp.md`, `openapi.yaml`).
2. Sure's OIDC: email allowlist support, and sign-in from a Home Screen web app (`oidc.md`).
3. Sure's built-in assistant using Anthropic through its configured provider (`ai.md`); fallback: disable the assistant or use the provider it supports.
4. Sure's external-assistant behavior, if the agent should call it instead of the REST API.
5. Whether SimpleFIN is supported by Sure as the owner expects, and its price.
6. Sure's image: `stable` digest, x86 build, RAM use with the worker and AI.
7. Lightsail/EC2/EBS/Elastic IP/Secrets Manager prices (section 4 range).
8. Robinhood: ToS on API use not read; v1 vs v2 for the owner's account; minimum order sizes and field names; order lookup by `client_order_id`; whether a key can be scoped; price-collar behavior of far-from-market limit orders; no sandbox was seen, not proven absent.
9. Whether Google OIDC allowlisting can be enforced at Google for a personal account (otherwise Sure-side only).

## 11. Open decisions (proposed default each)

1. Finance question entry beyond the console (capture-router route). Default: console only until P2 works.
2. Tracing: Default: off for the finance Lambda. Owner may instead allow redacted traces; not proposed.
3. Retention of `finance_answers`. Default: keep until the owner deletes; revisit if the table grows.
4. Approval expiry. Default: 10 minutes.
5. Instance size. Default: 2 GB x86 class; resize after P0 measures actual memory.
