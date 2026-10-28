import type { HttpResult } from "../crawl/http";

export interface MetadataClient { get(url: string): Promise<HttpResult> }
export interface WikiMetadata { url: string; title: string; revisionId: number }

export function wikisourceTitle(url: string): string | null {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.hostname !== "en.wikisource.org" || !u.pathname.startsWith("/wiki/") || u.search) return null;
  let title: string;
  try { title = decodeURIComponent(u.pathname.slice(6)).replace(/_/g, " "); } catch { return null; }
  return title && !title.includes(":") ? title : null;
}

/** Serial metadata query; deliberately never requests revision content or parsed page bodies. */
export async function readWikiMetadata(client: MetadataClient, title: string, sleep: (ms: number) => Promise<void>): Promise<WikiMetadata | null> {
  const url = new URL("https://en.wikisource.org/w/api.php");
  const params = { action: "query", format: "json", formatversion: "2", prop: "info|revisions", inprop: "url", rvprop: "ids", maxlag: "5", titles: title };
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await client.get(url.href);
    if (!result.ok) throw new Error(result.reason === "guard_refused" ? result.detail ?? result.reason : result.reason);
    let data: { error?: { code?: string }; query?: { pages?: { ns?: number; missing?: boolean; title?: string; fullurl?: string; revisions?: { revid?: number }[] }[] } };
    try { data = JSON.parse(result.body) as typeof data; } catch { throw new Error("wiki_bad_json"); }
    if (data.error?.code === "maxlag") {
      if (attempt === 3) throw new Error("wiki_maxlag");
      const headerWait = Number(result.headers["retry-after"] ?? 0) * 1000;
      const wait = Math.max(5000 * 2 ** attempt, Number.isFinite(headerWait) ? headerWait : 0);
      if (wait > 60_000) throw new Error("wiki_maxlag");
      await sleep(wait); continue;
    }
    if (data.error) throw new Error("wiki_api_error");
    const page = data.query?.pages?.[0];
    if (!page || page.missing || page.ns !== 0 || !page.title || !page.fullurl) return null;
    const revisionId = page.revisions?.[0]?.revid;
    if (!Number.isSafeInteger(revisionId) || Number(revisionId) <= 0 || !wikisourceTitle(page.fullurl)) return null;
    return { url: page.fullurl, title: page.title, revisionId: revisionId! };
  }
  return null;
}
