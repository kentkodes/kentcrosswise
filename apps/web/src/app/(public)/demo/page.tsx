// Public demo: the simulated hub in the Paper app frame. Every number comes from @kcw/demo-data, through
// the view model; the server builds it and the client component only holds the selected tab.
import { getDemoData } from "@kcw/demo-data";
import { PaperFrame } from "../_site/paper-frame";
import { DemoApp } from "./demo-app";
import { buildDemoView } from "./demo-view";
import d from "./demo.module.css";

export default function DemoPage() {
  const view = buildDemoView(getDemoData());
  return (
    <PaperFrame current="/demo">
      <div className={d.page}>
        <div className={d.head}>
          <div>
            <h1 className={d.title}>The hub, with made-up data</h1>
            <p className={d.sub}>Click around. Every person, note and number here is simulated; the real hub is private.</p>
          </div>
          <span className={d.pill}>Simulated data</span>
        </div>
        <DemoApp view={view} />
        <p className={d.note}>
          The live agent activity on the home page is real; everything inside this frame is generated from a fixed seed.
        </p>
      </div>
    </PaperFrame>
  );
}
