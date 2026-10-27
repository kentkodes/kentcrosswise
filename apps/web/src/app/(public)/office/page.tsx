// Public: sanitized events with independent pixel-art illustrations and a readable event list.
// It reads only the public feed API (D10: public pages import no server code).
import type { Metadata } from "next";
import { PublicShell } from "../_site/public-shell";
import { figures } from "../_site/fonts";
import { OfficeFeed } from "./office-feed";
import scene from "./preview/preview.module.css";
import s from "./office.module.css";

export const metadata: Metadata = { title: "Agent office | Kentcrosswise" };

export default function OfficePage() {
  return (
    <PublicShell current="/office">
      <main className={`${figures.variable} ${scene.previewMain}`}>
        <header className={s.heading}><h1>Agent office</h1><p>Real public activity, or a replay of the latest 20 events with original timestamps. Private tasks show as &quot;Private task&quot;.</p></header>
        <OfficeFeed />
      </main>
    </PublicShell>
  );
}
