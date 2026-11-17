// AR8a: merged, deployed and verified per merge commit. Public-safe fields only (task number, short
// SHA, run id, build id, times); no task text.
import { formatUtc } from "../format";
import { Dot, Region } from "../owner-ui";
import s from "../owner.module.css";
import type { Tone } from "../tones";
import type { ReleaseLabel, ReleaseRow } from "@/server/releases";

const RUNS_URL = "https://github.com/kentkodes/kentcrosswise/actions/runs/";

const TEXT: Record<ReleaseLabel, { text: string; tone: Tone }> = {
  merged: { text: "Merged", tone: "idle" },
  deployed: { text: "Deployed, not verified", tone: "warn" },
  verified: { text: "Verified", tone: "ok" },
  failed: { text: "Deploy failed", tone: "warn" },
  missing: { text: "No deploy result", tone: "warn" },
};

export function ReleasesBlock({ releases, unavailable = false }: { releases: ReleaseRow[]; unavailable?: boolean }) {
  return (
    <Region id="releases" title="Releases" level={3} testId="releases">
      {unavailable ? (
        <p className={`${s.note} ${s.pad}`}>Release state is unavailable right now.</p>
      ) : releases.length === 0 ? (
        <p className={`${s.note} ${s.pad}`}>No merges recorded yet.</p>
      ) : (
        <ol className={s.list}>
          {releases.map((r) => {
            const { text, tone } = TEXT[r.label];
            return (
              <li key={r.mergeSha} data-sha={r.mergeSha}>
                <p className={s.taskMeta}>
                  <span className={s.mono}>#{r.taskId}</span>{" "}
                  <span className={s.statusWord}>
                    <Dot tone={tone} />
                    <span data-field="release-label" className={s.emph}>
                      {text}
                    </span>
                  </span>{" "}
                  <span className={s.mono} data-field="sha">
                    {r.shortSha}
                  </span>{" "}
                  <span>
                    merged <time dateTime={r.mergedAt}>{formatUtc(r.mergedAt)}</time>
                  </span>
                  {r.deployedAt ? (
                    <>
                      {" "}
                      <span>
                        deployed <time dateTime={r.deployedAt}>{formatUtc(r.deployedAt)}</time>
                      </span>
                    </>
                  ) : null}
                  {r.verifiedAt ? (
                    <>
                      {" "}
                      <span>
                        verified <time dateTime={r.verifiedAt}>{formatUtc(r.verifiedAt)}</time>
                      </span>
                    </>
                  ) : null}
                  {r.failedAt ? (
                    <>
                      {" "}
                      <span>
                        failed <time dateTime={r.failedAt}>{formatUtc(r.failedAt)}</time>
                      </span>
                    </>
                  ) : null}
                  {r.runId !== null ? (
                    <>
                      {" "}
                      <a data-field="run" href={`${RUNS_URL}${r.runId}`}>
                        run {r.runId}
                        {r.runAttempt && r.runAttempt > 1 ? ` (attempt ${r.runAttempt})` : ""}
                      </a>
                    </>
                  ) : null}
                  {r.buildId ? (
                    <>
                      {" "}
                      <span>
                        build <span className={s.mono}>{r.buildId}</span>
                      </span>
                    </>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </Region>
  );
}
