// Essay pipeline status (sanitized): counts, fixed codes and public-domain titles only.
import type { EssayStatus } from "@/server/essay-status";
import { Region } from "../owner-ui";
import s from "../owner.module.css";

export function EssayStatusSection({ status }: { status: EssayStatus }) {
  return (
    <section aria-labelledby="essay-status" data-testid="essay-status" className={s.stack}>
      <div>
        <h2 id="essay-status" className={s.sectionHeading}>
          Essay pipeline
        </h2>
        <p className={s.note}>
          Stored essays: <strong data-field="stored" className={s.emph}>{status.essays.stored}</strong> · waiting for a category:{" "}
          <strong data-field="pending-category" className={s.emph}>
            {status.essays.pendingCategory}
          </strong>
        </p>
      </div>

      {status.sources.length === 0 ? (
        <Region>
          <p className={`${s.note} ${s.pad}`}>No sources registered.</p>
        </Region>
      ) : (
        <Region>
          <div className={s.tableWrap}>
            <table data-testid="essay-sources" className={s.table}>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Health</th>
                  <th scope="col" className={s.num}>
                    Links (approved / proposed / rejected)
                  </th>
                  <th scope="col" className={s.num}>
                    URLs (new / fetched / quarantined / link only / failed)
                  </th>
                </tr>
              </thead>
              <tbody>
                {status.sources.map((src, i) => (
                  <tr key={`${src.name}-${i}`}>
                    <th scope="row">{src.name}</th>
                    <td>
                      {src.health}
                      {src.pausedBy ? <> · paused by {src.pausedBy}</> : null}
                      {src.healthReason ? <> · {src.healthReason}</> : null}
                    </td>
                    <td className={s.num}>
                      {src.links.approved} / {src.links.proposed} / {src.links.rejected}
                    </td>
                    <td className={s.num}>
                      {src.urls.new} / {src.urls.fetched} / {src.urls.quarantined} / {src.urls.link_only} / {src.urls.failed}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Region>
      )}

      <Region id="essay-quarantine-title" level={3} title="Quarantine">
        {status.quarantine.length === 0 ? (
          <p className={`${s.note} ${s.pad}`}>Nothing in quarantine.</p>
        ) : (
          <ul data-testid="essay-quarantine" className={s.list}>
            {status.quarantine.map((q) => (
              <li key={q.code} className={s.mono}>
                {q.code}: {q.count}
              </li>
            ))}
          </ul>
        )}
      </Region>

      <Region id="essay-works-title" level={3} title="Approved works">
        {status.works.length === 0 ? (
          <p className={`${s.note} ${s.pad}`}>No approved works yet.</p>
        ) : (
          <>
            <div className={s.tableWrap}>
              <table data-testid="essay-works" className={s.table}>
                <thead>
                  <tr>
                    <th scope="col">Title</th>
                    <th scope="col">Author</th>
                    <th scope="col">Stage</th>
                    <th scope="col">Code</th>
                  </tr>
                </thead>
                <tbody>
                  {status.works.map((w, i) => (
                    <tr key={i}>
                      <th scope="row">{w.title}</th>
                      <td>{w.author}</td>
                      <td data-field="stage">{w.stage}</td>
                      <td data-field="code">{w.code ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {status.worksTotal > status.works.length ? (
              <p className={`${s.note} ${s.pad}`}>
                Showing {status.works.length} of {status.worksTotal} approved works.
              </p>
            ) : null}
          </>
        )}
      </Region>
    </section>
  );
}
