# Integration research for kentcrosswise.com (researched 2026-10-22)

Scope: a private single-user Next.js app on AWS serverless. Secrets go in AWS Secrets Manager. Every claim has a source URL. **UNVERIFIED** means I could not confirm it in an official source.

Secrets to store in Secrets Manager, by integration:
- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, plus the user's refresh token.
- Instagram: Instagram App ID, Instagram App Secret, plus the long-lived token, which must be rewritten after every refresh.
- TikTok: `client_key`, `client_secret`, plus the refresh token. TikTok may rotate the refresh token, so it must be rewritten too.
- `ANTHROPIC_API_KEY`
- `TYPESAFE_API_KEY`
- `LANGSMITH_API_KEY`
- VAPID public/private keys

---

## 1. Google Cloud (Sign-in, Calendar, YouTube)

### Steps
1. **Enable the APIs.** Console > select or create a project > API Library > enable **Google Calendar API**, **YouTube Data API v3** and **YouTube Analytics API**.
   - Source: https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps (says to enable the YouTube Data API and "any other APIs your app uses")
2. **Register the app with Google Auth Platform.** You must do this before you can create a client.
   - Source: https://support.google.com/cloud/answer/15549257
   - **Branding:** app name, support email, and authorized domains. Add `kentcrosswise.com`.
   - **Audience:** set User type and Publishing status (choices below).
   - **Data Access:** add the scopes.
3. **Choose External, not Internal.** Internal limits access to members of your Google Cloud Organization, and anyone else gets `org_internal`. A personal gmail account has no Workspace or Cloud Identity org, so External is the only option.
   - Source: https://support.google.com/cloud/answer/15549945?hl=en
   - That Internal needs a Workspace/Cloud Identity org is also stated at https://support.google.com/cloud/answer/13464323
4. **Pick a publishing status.**
   - **Testing:** up to 100 test users. "Their authorizations expire seven days after consent, and any refresh tokens expire too." Exception: if you request only `openid`, `email` and `profile`, there is no 7-day expiry. **Calendar and YouTube scopes therefore trigger the 7-day expiry in Testing.** Source: https://support.google.com/cloud/answer/15549945?hl=en. The 7-day rule is also stated at https://developers.google.com/identity/protocols/oauth2
   - **In production (Publish app):** you can publish without verification. Because the app requests sensitive scopes before verification, Google shows an "unverified app" warning, and a lifetime cap of 100 new users applies. Source: https://support.google.com/cloud/answer/15549945?hl=en
   - Verification is not required for "personal use (fewer than 100 users)". Those users can click past the unverified-app warning. Source: https://support.google.com/cloud/answer/13464323
   - **Recommendation:** publish to In production and stay unverified. The one user clicks through the warning once (exact wording is **UNVERIFIED**; it is commonly "Google hasn't verified this app" > Advanced > "Go to ... (unsafe)"). The refresh token is then not subject to the 7-day expiry.
   - Refresh tokens otherwise die after six months unused, and after 100 tokens per account per client the oldest is silently revoked. Source: https://developers.google.com/identity/protocols/oauth2
   - After switching to production, re-consent once so a new token is issued. This is community advice, **UNVERIFIED** officially: https://hackyourway.substack.com/p/google-oauth-agent-access
5. **Create the client.** Google Auth Platform > Clients > **CREATE CLIENT** > Web application.
   - Authorized JavaScript origin: `https://kentcrosswise.com`
   - Redirect URIs, for example:
     - `https://kentcrosswise.com/api/auth/callback/google` (the Auth.js default path is **UNVERIFIED** here; match your auth library)
     - `http://localhost:3000/...` for dev
   - HTTPS is required except for localhost. Changes take 5 minutes to a few hours to apply.
   - "Client secret will only be shown after you create the client." Copy it straight into Secrets Manager.
   - A client inactive for 6 months is auto-deleted.
   - Source: https://support.google.com/cloud/answer/15549257
   - Redirect URIs must match exactly, including scheme, case and trailing slash: https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps
6. **Authorization request.** Send `access_type=offline` to get a refresh token. A refresh token is only returned on first consent, so use `prompt=consent` to get a new one. `include_granted_scopes=true` enables incremental auth. Source: https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps

### Scopes (descriptions from https://developers.google.com/identity/protocols/oauth2/scopes)
- **Sign-in:** `openid`, `email`, `profile`
- **Calendar, create events:** pick one.
  - `https://www.googleapis.com/auth/calendar.events.owned`: create/change events on calendars you own. This is the narrowest that still writes to your primary calendar.
  - `https://www.googleapis.com/auth/calendar.app.created`: only on secondary calendars the app creates. Narrowest of all.
  - `calendar.events`: all calendars.
- **YouTube:**
  - `https://www.googleapis.com/auth/youtube.readonly`
  - `https://www.googleapis.com/auth/yt-analytics.readonly`
  - The Analytics reports page says requests "now require" `youtube.readonly` as well. Source: https://developers.google.com/youtube/analytics/reference/reports/query
- **Sensitive/restricted classification of these scopes: UNVERIFIED.** The Calendar auth page does not label them: https://developers.google.com/workspace/calendar/api/auth. I expect the Calendar and YouTube scopes to be "sensitive", not "restricted".

### Reading your own channel stats
- **Lifetime stats:** `GET https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true`. Costs 1 quota unit; `mine=true` needs an authorized request. Source: https://developers.google.com/youtube/v3/docs/channels/list
  - `subscriberCount` "is rounded down to three significant figures". For exact numbers, use Analytics `subscribersGained` / `subscribersLost` (metric names **UNVERIFIED** beyond `subscribersGained`).
  - `viewCount` counts views across all videos. "Starting August 24, 2026," a view is counted when playback begins, including autoplay. Source: https://developers.google.com/youtube/v3/docs/channels
- **Time series:** `GET https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&metrics=views,subscribersGained`. Source: https://developers.google.com/youtube/analytics/reference/reports/query

### Quotas and cost
- YouTube Data API: 10,000 units/day for most endpoints, plus 100 `search.list` and 100 `videos.insert` calls/day. A list read usually costs 1 unit. Source: https://developers.google.com/youtube/v3/getting-started
- Calendar API and YouTube Analytics quotas: **UNVERIFIED**, not fetched. Both are free at personal volumes, also **UNVERIFIED**.

### Gotchas
- Testing status plus any Calendar or YouTube scope means re-login every 7 days. Publish to production.
- Keep the project contact email current, or you risk losing API access: https://support.google.com/cloud/answer/13464321

---

## 2. Instagram (Business or Creator account)

### Which API path
Use **Instagram API with Instagram Login** (Business Login for Instagram).
- Host is `graph.instagram.com`. No Facebook Page is needed. Permissions use the `instagram_business_*` family.
- It supports insights but not ads, tagging or hashtag search.
- Sources: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login and https://developers.facebook.com/docs/instagram-platform/overview

### Steps (https://developers.facebook.com/docs/instagram-platform/create-an-instagram-app)
1. Go to developers.facebook.com and register as a Meta developer. The registration flow itself is **UNVERIFIED** (not fetched).
2. App Dashboard > **Create App**.
   - Use case: **Other**
   - App type: **Business** (required for the Instagram product)
   - Enter a name and contact email.
3. Connecting a verified business is optional now. It is only required before publishing (Live).
4. Instagram product > **Set up**. This adds "API setup with Instagram login".
5. Add your Instagram account as a tester. The account must be **public**. Go to **App Roles > Roles** or Instagram > API setup with Instagram login, then log in to accept.
6. **Set up Instagram business login.**
   - Add the redirect URL, e.g. `https://kentcrosswise.com/api/instagram/callback`.
   - In Business login settings, add OAuth redirect URIs, a deauthorize callback URL and a data-deletion URL.
   - Note the **Instagram App ID** and **Instagram App Secret**. These differ from the Meta app ID.
   - Source: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
   - The dashboard may add a trailing slash to the redirect URI, and `redirect_uri` must match exactly.
7. **Authorize.** `https://www.instagram.com/oauth/authorize?client_id=...&redirect_uri=...&response_type=code&scope=instagram_business_basic,instagram_business_manage_insights&state=...`
   - The code is valid 1 hour and works once. Strip the trailing `#_`.
8. **Exchange the code for a short-lived token.** `POST https://api.instagram.com/oauth/access_token` with `client_id`, `client_secret`, `grant_type=authorization_code`, `redirect_uri` and `code`. The token lasts 1 hour.
9. **Exchange for a long-lived token.** `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=...&access_token=...`. The token lasts **60 days**.
10. **Refresh.** `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=...`
    - Allowed when the token is at least 24 hours old and not expired, and has `instagram_business_basic`. Each refresh gives a new 60 days.
    - A token not refreshed within 60 days cannot be refreshed. Schedule a refresh about every 30 days.
    - Source: https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token

### Permissions and data
- **`followers_count`** is a field on the IG User node: `GET https://graph.instagram.com/<ver>/<IG_USER_ID>?fields=followers_count,media_count,username`. Needs `instagram_business_basic`.
  - Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user
  - The `/me` shortcut is **UNVERIFIED** on that page.
- **Account insights:** `GET /<IG_USER_ID>/insights?metric=views,reach,...`. Needs `instagram_business_basic` and `instagram_business_manage_insights`.
  - Most metrics are `period=day` with `metric_type=total_value`. Without `since`/`until`, it looks back 24 hours.
  - Data may be delayed up to 48 hours.
  - The `follower_count` *metric* and `online_followers` are unavailable for accounts under 100 followers.
  - Source: https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights
- **Rename:** `impressions` was deprecated in v22.0 and for all versions on April 21, 2025. Use **`views`** instead (same source).
  - At media level, `impressions` is deprecated for media created after July 2, 2024.
  - `views` is supported for FEED, REELS and STORY.
  - Source: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/

### App Review
- **Standard Access** (the default) is "intended for apps that will only be used by people who have roles on them". Advanced Access, which needs App Review and Business Verification, is only needed for accounts you don't own or manage. Sources: https://developers.facebook.com/docs/instagram-platform/overview and https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
- Development-mode apps can request standard-access permissions from role users. Source: https://developers.facebook.com/docs/development/build-and-test/app-modes
- **Conflict:** the create-app guide says "Instagram requires App Review before your app can access live data." My reading is that this applies to Live mode and non-role users, and that a development-mode app with yourself as tester works without review. This is **UNVERIFIED end-to-end**, so test before relying on it.
- Meta also notes that Standard Access "may cause some features to malfunction".

### Rate limits and cost
- Rate limit: calls within 24 hours = 4800 × the number of impressions, per app-user pair. Source: https://developers.facebook.com/docs/instagram-platform/overview
- Cost: free (**UNVERIFIED**, no price page fetched).

---

## 3. TikTok (Login Kit + Display API)

### Steps (https://developers.tiktok.com/doc/getting-started-create-an-app)
1. Create a TikTok developer account at developers.tiktok.com. An organization is recommended, but an individual account is allowed.
2. **Manage apps** > new app.
   - Icon: 1024×1024.
   - Fill in name, category and description.
   - Platform: **Web** with the official website URL.
3. **URL verification.** For apps created after September 9, 2024, the Terms of Service URL, Privacy Policy URL and Web URL must be verified, by domain or by URL prefix with an uploaded signature file. This is required "before submitting your app for review". So kentcrosswise.com needs public `/terms` and `/privacy` pages.
4. **Add products:** **Login Kit**, with a Redirect URI, and the **Display API**.
5. **Add scopes:**
   - `user.info.basic`
   - `user.info.stats`: `follower_count`, `following_count`, `likes_count`, `video_count`
   - `video.list`
   - Source: https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info
6. **Sandbox (the realistic path for a personal app).** Toggle the app to **Sandbox** > Create Sandbox > configure the products. Then go to **Sandbox settings > Target users > Add account**, add your own TikTok account, and log in.
   - Limits: up to 5 sandboxes and 10 target users, all accounts you own.
   - Source: https://developers.tiktok.com/doc/add-a-sandbox
7. **Authorize.** `https://www.tiktok.com/v2/auth/authorize/?client_key=...&scope=user.info.basic,user.info.stats,video.list&redirect_uri=...&state=...&response_type=code`. Source: https://developers.tiktok.com/doc/login-kit-web
8. **Exchange the code.** `POST https://open.tiktokapis.com/v2/oauth/token/` (form-encoded) with `client_key`, `client_secret`, `code` (URL-decoded), `grant_type=authorization_code` and `redirect_uri`.
   - PKCE `code_verifier` is "Required for mobile and desktop app only".
   - Source: https://developers.tiktok.com/doc/oauth-user-access-token-management

### Data
- **Followers:** `GET https://open.tiktokapis.com/v2/user/info/?fields=follower_count,likes_count,video_count`
- **Per-video views:** `POST https://open.tiktokapis.com/v2/video/list/?fields=id,title,view_count,like_count,comment_count,share_count,create_time`
  - Page size is `max_count` up to 20. Paginate with `cursor` and `has_more`.
  - Source: https://developers.tiktok.com/doc/tiktok-api-v2-video-list
  - Field list: https://developers.tiktok.com/doc/tiktok-api-v2-video-object
  - That these count fields are covered by the `video.list` scope is **UNVERIFIED**. The object page doesn't name the scope.

### Tokens
- Access token: 24 hours.
- Refresh token: **365 days**.
- Refresh with `POST /v2/oauth/token/` and `grant_type=refresh_token`. The returned refresh token may change, so always store the new one.
- After 365 days you must re-login (implied by the docs; the absence of sliding renewal is **UNVERIFIED**).
- Source: https://developers.tiktok.com/doc/oauth-user-access-token-management

### Redirect URI rules (https://developers.tiktok.com/doc/login-kit-web)
- Absolute and beginning with `https`.
- At most 10, each under 512 characters.
- Static: no query parameters and no `#` fragment.
- So `http://localhost` dev callbacks are not accepted. Use a tunnel or the deployed domain. That `https://localhost` works is **UNVERIFIED**.

### Rate limits and cost
- `/v2/user/info/`, `/v2/video/list/` and `/v2/video/query/`: 600 requests/minute each (sliding window). Source: https://developers.tiktok.com/doc/tiktok-api-v2-rate-limit
- Cost: free (**UNVERIFIED**).

### Review (key problem)
The App Review Guidelines say:
- "Apps must not be for private or personal use."
- An externally facing website is required, and it can't be just a landing or login page.
- Apps still in development or testing will not be approved.

Source: https://developers.tiktok.com/doc/app-review-guidelines. A personal single-user app is therefore very likely to be **rejected** in production review.

Sandbox needs no review, and you can add your own account as a target user. However, TikTok frames sandbox as a pre-submission test stage, not long-term use (https://developers.tiktok.com/blog/introducing-sandbox). Two things are **UNVERIFIED**:
- Whether sandbox returns your account's *real* follower and view numbers.
- Whether `user.info.stats` is grantable in sandbox.

Test this first, before building any TikTok UI. The Display API get-started page also lists "approval for both a Login Kit and TikTok API products" as a prerequisite: https://developers.tiktok.com/doc/display-api-get-started

---

## 4. Anthropic API

1. Sign up at the Claude Console: https://platform.claude.com/. The signup click path is **UNVERIFIED**.
2. **Buy credits:** Settings > Billing > **Buy credits** (Admin or Billing role).
   - Credits are available immediately. Auto-reload can be set on the same page.
   - Credits expire 1 year after purchase and are non-refundable.
   - Minimum purchase: **UNVERIFIED**.
   - Source: https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-api-usage
3. Create an API key in the Console. Exact path **UNVERIFIED**, likely Settings > API keys.
4. **Model:** `claude-haiku-5-5` is **confirmed**, as both API ID and alias. It has a 1M-token context and 128K max output, and retires no sooner than October 7, 2027. Source: https://platform.claude.com/docs/en/about-claude/models/overview
5. **Price per million tokens** (https://platform.claude.com/docs/en/about-claude/pricing)

   | Price item | Prompts ≤100,000 tokens | Prompts >100,000 tokens |
   |---|---|---|
   | Input | $0.10 | $0.50 |
   | Output | $0.50 | $2.50 |
   | 5-minute cache write | $0.125 | — |
   | 1-hour cache write | $0.20 | — |
   | Cache hit | $0.01 | — |
   | Batch input | $0.05 | — |
   | Batch output | $0.25 | — |

   - Haiku 5.5 is the only current model with this long-prompt tier. Keep prompts under 100K tokens.
   - The `inference_geo: "us"` setting costs 1.1×.
6. **Tiers** (https://platform.claude.com/docs/en/api/rate-limits)
   - The tiers are now Evaluation, Start, Build, Scale and Custom, not "Tier 1–4". New organizations may start in a lower **Evaluation** tier.
   - Monthly spend caps: Start $500, Build $1,000, Scale $200,000. Set your own lower cap under Billing > Spend limits.
   - Haiku 5.5 on Start: 1,000 RPM, 2M ITPM and 400K OTPM.
   - At the spend cap, requests get a 429 with `enforced_spend_limit_reached` and no `retry-after`.

---

## 5. Jev (TypeSafe AI)

- **Status:**
  - typesafe.ai describes Jev as "in early access" with a link to the console: https://typesafe.ai/
  - No waitlist is mentioned. Whether self-serve signup is open is **UNVERIFIED**; the docs only say to log in to the console.
  - The release date (15 September 2026) comes from third-party sources: https://openrouter.ai/blog/insights/what-is-jev/
- **Signup and key:**
  - Create an account at https://console.typesafe.ai/ and get the key at `console.typesafe.ai/keys`. Env var: `TYPESAFE_API_KEY`.
  - Source: https://docs.typesafe.ai/introduction/quickstart
- **Endpoint:** `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer <key>` and JSON.
  - Body: `{ "model": "jev-latest", "state": "<text or JSON>", "questions": { "<id>": { "type": "choice"|"score"|"noul", "instructions": "...", "criteria": ... } } }`
  - Response: `{ "model": "jev-1.13.0", "answers": { "<id>": { "type", "choice"|"score"|"noul", "confidence", "probabilities" } }, "usage": { "input_tokens", "output_tokens" } }`
  - Choice and Score return `confidence` and `probabilities`. Noul returns 0–1.
  - Source: https://docs.typesafe.ai/introduction/quickstart and https://docs.typesafe.ai/introduction
  - The question-map shape is paraphrased. Use the OpenAPI spec for exact field names: https://api.typesafe.ai/openapi.json
- **Note:** a third-party blog cites a different domain (`thejevai.com`). Ignore it; the official docs say `api.typesafe.ai`.
- **Models** (https://docs.typesafe.ai/models.md)
  - `jev-1.13.0`: what `jev-latest` points to.
  - `jev-1.14.0`: what `jev-preview` points to; released October 14, 2026.
  - Context: 64k per request and 32k per question. Opt-in long context goes to 262k via the `TypeSafe-Danger-Zone-Long-Context: true` header.
  - Text input only.
- **Pricing:** $0.042 per million input tokens; output is free. Sources: https://docs.typesafe.ai/models.md and https://typesafe.ai/
- **Rate limits:**
  - Set per organization in tokens and requests per second, and shown in the console. No numbers are published.
  - 429 means rate limit and 529 means overloaded; retry with backoff. The body limit is 32 MiB.
  - Sources: https://docs.typesafe.ai/models.md and https://docs.typesafe.ai/api/errors.md
- **SDKs:**
  - JS: `@typesafe-ai/sdk` (Node 20+). Python: `typesafe-sdk`. Source: https://docs.typesafe.ai/introduction/quickstart
  - There is also a Pydantic AI integration, `pydantic-ai-slim[typesafe]`: https://pydantic.dev/docs/ai/models/typesafe/
  - No LangChain.js integration was found (**UNVERIFIED**). Call it from a LangGraph node with the JS SDK.

---

## 6. LangSmith

- **Developer plan:** $0, 1 seat maximum, up to 5k base traces/month, then pay-as-you-go. Base traces are retained 14 days. Source: https://www.langchain.com/pricing
  - Overage price: **UNVERIFIED**. The official page doesn't list it, and third parties disagree ($2.50 vs $0.50 per 1k).
  - One source says the plan is capped at 5k until a card is added (**UNVERIFIED**).
- **API key:** create it in LangSmith Settings > API Keys. Exact click path **UNVERIFIED**.
- **Env vars for LangGraph JS** (https://docs.langchain.com/langsmith/trace-with-langgraph)
  - `LANGSMITH_TRACING=true`
  - `LANGSMITH_API_KEY=...`
  - `LANGSMITH_ENDPOINT`: only for non-US regions, e.g. EU.
  - `LANGCHAIN_CALLBACKS_BACKGROUND=false` **on serverless (Lambda)**, so traces flush before the function freezes.
  - `LANGSMITH_PROJECT=<name>` is optional; it wasn't on the fetched page (**UNVERIFIED**, but standard).

---

## 7. Web Push on iPhone

Source: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- Requires **iOS/iPadOS 16.4+**.
- Works **only for Home Screen web apps**: the user must use Share > Add to Home Screen. It does not work in a Safari tab.
- Needs a web app manifest with `display: "standalone"` or `"fullscreen"`.
- The permission request must come "in response to direct user interaction", such as tapping a button.
- No Apple Developer Program membership is needed.
- If you restrict outbound hosts, allow `*.push.apple.com`.
- The article doesn't mention VAPID, but says it is the standards-based W3C Push API. The standard Push API uses a VAPID public key as `applicationServerKey`, and the server signs with the private key (e.g. via the `web-push` npm package). This VAPID detail is **UNVERIFIED** against an Apple page; Apple's developer doc did not load.

---

## Corrections to our assumptions

1. **TikTok is the big risk.**
   - TikTok's App Review Guidelines say "Apps must not be for private or personal use", and in-development apps aren't approved. A single-user app will almost certainly fail production review.
   - The only path is a **Sandbox** with your own account as a target user. TikTok frames that as pre-review testing, and it is **UNVERIFIED** whether sandbox returns real stats or allows `user.info.stats`.
   - Prototype the TikTok OAuth and data call in sandbox *first*. Plan a fallback: manual entry, or drop TikTok.
   - Redirect URIs must be HTTPS (no `http://localhost`).
   - Public Terms and Privacy pages on kentcrosswise.com must be domain-verified.
2. **Google "Testing" status breaks after 7 days** whenever Calendar or YouTube scopes are requested. Publish the app to **In production** and stay unverified. That is allowed for personal use under 100 users; the user sees an "unverified app" warning once.
3. **Use Internal is not possible** with a personal gmail account. Choose External.
4. **Instagram:** use Instagram Login, not Facebook Login, so no Page is needed. `impressions` is gone; use `views`.
   - Expect insights to arrive up to 48 hours late.
   - The `follower_count` *metric* needs 100+ followers. The `followers_count` *field* has no such limit.
   - App Review should not be needed for your own tester account in development mode, but this is **UNVERIFIED** end-to-end.
   - The long-lived token must be refreshed before 60 days, or you must log in again.
5. **YouTube `subscriberCount` is rounded down to 3 significant figures.** Use YouTube Analytics for exact daily gains.
6. **Anthropic tiers are renamed** to Evaluation, Start, Build and Scale, with monthly spend caps. Haiku 5.5 has a price cliff above 100K-token prompts. The model ID `claude-haiku-5-5` is confirmed.
7. **Jev is in "early access".** Open self-serve availability is **UNVERIFIED**. Numeric rate limits are not published; they are per organization and shown in the console. `jev-latest` is 1.13, not 1.14.
8. **LangSmith on Lambda** needs `LANGCHAIN_CALLBACKS_BACKGROUND=false`, or traces are lost.
9. **iPhone push only works after "Add to Home Screen"** on iOS 16.4+. The app needs a manifest and a service worker.
