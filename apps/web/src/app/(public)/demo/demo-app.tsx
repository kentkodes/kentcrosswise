"use client";
// The /demo frame (PL5): two tabs, the public Log (default) and the public-domain Essays. Only the selected tab is
// client state; the essays arrive as a serializable view model from the server page, the log loads in the browser.
import { useId, useState } from "react";
import type { DemoView } from "./demo-view";
import { EssaysSection } from "./essays-section";
import { LogSection } from "./log-section";
import d from "./demo.module.css";

const TABS = ["Log", "Essays"] as const;
type Tab = (typeof TABS)[number];

export function DemoApp({ view }: { view: DemoView }) {
  const [tab, setTab] = useState<Tab>("Log");
  // The section is named by its h2, which carries this id.
  const titleId = useId();
  return (
    <div className={d.frame}>
      <nav className={d.tabs} aria-label="Sections">
        {TABS.map((t) => (
          <button key={t} type="button" className={d.tab} aria-pressed={t === tab} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      <section className={d.body} aria-labelledby={titleId}>
        {tab === "Log" && <LogSection titleId={titleId} />}
        {tab === "Essays" && <EssaysSection view={view} titleId={titleId} />}
      </section>
    </div>
  );
}
