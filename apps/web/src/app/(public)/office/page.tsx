// Public: the agent office (P2-16 text list; the pixel-art office is Phase 4).
// It reads only the public feed API (D10: public pages import no server code).
import type { Metadata } from "next";
import { PublicShell } from "../_site/public-shell";
import { figures } from "../_site/fonts";
import { OfficeFeed } from "./office-feed";

export const metadata: Metadata = { title: "Agent office | Kentcrosswise" };

export default function OfficePage() {
  return (
    <PublicShell current="/office">
      <main className={figures.variable}>
        <h1>Agent office</h1>
        <p>Real public events from the agents building this site. When the feed is quiet, replay the latest 20 events at their original timestamps. Private tasks show as &quot;Private task&quot;.</p>
        <OfficeFeed />
      </main>
    </PublicShell>
  );
}
