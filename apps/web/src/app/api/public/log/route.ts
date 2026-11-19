// GET /api/public/log: the public log of the owner's reviewed entries (DESIGN §4.6, PL4). Reads through web_public
// only (v_public_records and v_public_log_counts): the newest published records with their sanitized text and
// code-only step lines, the published, withheld and awaiting-review counts, and the fixed label. CloudFront honours
// s-maxage, so the database sees at most one query per 30 s.
import { loadPublicLog } from "@/server/public-log";

export const dynamic = "force-dynamic";

const CACHE_CONTROL = "public, max-age=30, s-maxage=30";

export async function GET(): Promise<Response> {
  return Response.json(await loadPublicLog(), { headers: { "Cache-Control": CACHE_CONTROL } });
}
