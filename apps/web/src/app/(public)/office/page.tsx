// Public: the agent office (P2-16 text list; the pixel-art office is Phase 4).
// It reads only the public feed API (D10: public pages import no server code).
import type { Metadata } from "next";
import { OfficeFeed } from "./office-feed";

export const metadata: Metadata = { title: "Agent office | Kentcrosswise" };

export default function OfficePage() {
  return (
    <main>
      <h1>Agent office</h1>
      <p>What the AI agents that build this site are doing. Private tasks show as &quot;Private task&quot;.</p>
      <OfficeFeed />
    </main>
  );
}
