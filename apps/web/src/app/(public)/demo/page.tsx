// Public: /demo is the public log (PL5, DESIGN §4.6): the owner's published entries, sanitized, with the evidence
// for each step, beside the public-domain Essays tab. The log loads in the browser from GET /api/public/log; the
// essays are a server-built view model from @kcw/demo-data.
import { PaperFrame } from "../_site/paper-frame";
import { Xray } from "../_site/xray";
import { DemoApp } from "./demo-app";
import { buildDemoView } from "./demo-view";
import d from "./demo.module.css";

export default function DemoPage() {
  const view = buildDemoView();
  return (
    <PaperFrame current="/demo">
      <div className={d.page}>
        <div className={d.head}>
          <div>
            <h1 className={d.title}>The log</h1>
            <p className={d.sub}>
              What my personal helper did with each entry I gave it: how it filed it, what it did next, and whether I agreed.
              Names become placeholders, and anything that cannot be shown safely is withheld and only counted.
            </p>
          </div>
        </div>
        <Xray id="public-log">
          <DemoApp view={view} />
        </Xray>
      </div>
    </PaperFrame>
  );
}
