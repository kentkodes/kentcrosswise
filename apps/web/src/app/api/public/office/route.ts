// Versioned connected-office read surface. The five-field agent-events feed is unchanged.
import { decodeOfficeCursor, loadOfficeProjection, OfficeRequestError, type OfficeRequest } from "../../../../server/office-projection";

export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "no-store" };
// Available bootstrap/state snapshots may be shared for 2 s: CloudFront honours s-maxage and keys on
// every query string (infra/modules/web server cache policy), so mode=bootstrap and mode=state (and
// each privacy_epoch) are cached separately and the database sees at most one snapshot query per 2 s
// per key. A privacy withdrawal can therefore appear up to 2 s later (owner-accepted, P2-1 / Q1).
// Incremental cursors, unavailable envelopes, 400s and 503s stay no-store.
const SNAPSHOT_HEADERS = { "Cache-Control": "public, max-age=2, s-maxage=2" };
const COUNTER = /^(?:0|[1-9][0-9]{0,18})$/;

function invalid(): never { throw new OfficeRequestError("cursor"); }
function parseRequest(url: URL): OfficeRequest {
  const params = url.searchParams;
  const mode = params.get("mode") ?? "bootstrap";
  const allowed = mode === "bootstrap" ? ["mode"] : mode === "state" ? ["mode", "privacy_epoch"]
    : mode === "incremental" ? ["mode", "cursor", "limit", "rebind"] : invalid();
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid();
  if (mode === "bootstrap") return { mode };
  if (mode === "state") {
    const epoch = params.get("privacy_epoch");
    if (epoch === null) return { mode };
    if (!COUNTER.test(epoch) || BigInt(epoch) > 9223372036854775807n) invalid();
    return { mode, privacy_epoch: epoch };
  }
  const cursor = params.get("cursor");
  decodeOfficeCursor(cursor);
  const limit = params.get("limit");
  if (limit !== null && (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit))) invalid();
  const rebind = params.get("rebind");
  if (rebind !== null && rebind !== "true" && rebind !== "false") invalid();
  return { mode: "incremental", cursor: cursor!, ...(limit === null ? {} : { limit: Number(limit) }), ...(rebind === null ? {} : { rebind: rebind === "true" }) };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const query = parseRequest(new URL(request.url));
    const envelope = await loadOfficeProjection(query);
    const shared = query.mode !== "incremental" && envelope.available;
    return Response.json(envelope, { headers: shared ? SNAPSHOT_HEADERS : HEADERS });
  } catch (error) {
    if (error instanceof OfficeRequestError) return Response.json({ error: "Invalid office request" }, { status: 400, headers: HEADERS });
    // The loader already converts database failures into an unavailable envelope.
    // Unexpected route failures still return no content from the thrown error.
    return Response.json({ error: "Office unavailable" }, { status: 503, headers: HEADERS });
  }
}
