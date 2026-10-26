// GET /healthz: liveness probe for load balancers, orchestrators and uptime monitors. No auth,
// no database: it answers as long as the server process runs.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response("ok", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}
