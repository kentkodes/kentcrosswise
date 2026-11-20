// GET /connections/demo/callback: where Google returns after the demo calendar consent (PL7). Owner only. The
// redirect URI registered in the Google console is <site origin>/connections/demo/callback.
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { DEMO_CONSENT_COOKIE, demoRedirectUri, siteOrigin } from "../../../../../server/demo-consent";
import { requireOwner } from "../../../../../server/owner";
import { handleDemoCallback } from "../../demo-callback";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  await requireOwner();
  const origin = siteOrigin(await headers());
  if (!origin) return new Response("Bad host", { status: 400 });
  const jar = await cookies();
  const code = await handleDemoCallback(new URL(request.url).searchParams, jar.get(DEMO_CONSENT_COOKIE)?.value, demoRedirectUri(origin));
  const res = NextResponse.redirect(`${origin}/connections?n=${code}#demo-calendar`, 303);
  // One use: the state and verifier are spent whatever the outcome.
  res.cookies.set(DEMO_CONSENT_COOKIE, "", { path: "/connections/demo", maxAge: 0, httpOnly: true, secure: origin.startsWith("https:"), sameSite: "lax" });
  return res;
}
