// GET /api/public/agent-events?since=<id>: the public office feed (DESIGN §4.5 step 5, D11).
// Reads through web_public only. CloudFront honours s-maxage (infra/modules/web server cache
// policy), so the database sees at most one query per 5 s per distinct `since`.
import { loadPublicFeed, parseSince } from "@/server/public-feed";

export const dynamic = "force-dynamic";

const CACHE_CONTROL = "public, max-age=5, s-maxage=5";

export async function GET(request: Request): Promise<Response> {
  const since = parseSince(new URL(request.url).searchParams.get("since"));
  if (since === null) {
    return Response.json({ error: "since must be an event id" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const feed = await loadPublicFeed(since);
  return Response.json(feed, { headers: { "Cache-Control": CACHE_CONTROL } });
}
