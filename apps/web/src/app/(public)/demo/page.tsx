// Public demo: the simulated hub in the Paper app frame. Every number comes from @kcw/demo-data, through
// the view model; the server builds it and the client component only holds the selected tab.
import { getDemoData } from "@kcw/demo-data";
import { PaperFrame } from "../_site/paper-frame";
import { Xray } from "../_site/xray";
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
          <Xray id="demo-data" align="end">
            <span className={d.pill}>Simulated data</span>
          </Xray>
        </div>
        <Xray id="demo-app">
          <DemoApp view={view} />
        </Xray>
        <p className={d.note}>
          The live agent activity on the home page is real; everything inside this frame is generated from a fixed seed.
        </p>
      </div>
    </PaperFrame>
  );
}
