// Essay pipeline status (sanitized): counts, fixed codes and public-domain titles only.
import type { EssayStatus } from "@/server/essay-status";

export function EssayStatusSection({ status }: { status: EssayStatus }) {
  return (
    <section aria-labelledby="essay-status" data-testid="essay-status">
      <h2 id="essay-status">Essay pipeline</h2>
      <p>
        Stored essays: <strong data-field="stored">{status.essays.stored}</strong> · waiting for a category:{" "}
        <strong data-field="pending-category">{status.essays.pendingCategory}</strong>
      </p>

      {status.sources.length === 0 ? (
        <p>No sources registered.</p>
      ) : (
        <table data-testid="essay-sources">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Health</th>
              <th scope="col">Links (approved / proposed / rejected)</th>
              <th scope="col">URLs (new / fetched / quarantined / link only / failed)</th>
            </tr>
          </thead>
          <tbody>
            {status.sources.map((s, i) => (
              <tr key={`${s.name}-${i}`}>
                <th scope="row">{s.name}</th>
                <td>
                  {s.health}
                  {s.pausedBy ? <> · paused by {s.pausedBy}</> : null}
                  {s.healthReason ? <> · {s.healthReason}</> : null}
                </td>
                <td>
                  {s.links.approved} / {s.links.proposed} / {s.links.rejected}
                </td>
                <td>
                  {s.urls.new} / {s.urls.fetched} / {s.urls.quarantined} / {s.urls.link_only} / {s.urls.failed}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Quarantine</h3>
      {status.quarantine.length === 0 ? (
        <p>Nothing in quarantine.</p>
      ) : (
        <ul data-testid="essay-quarantine">
          {status.quarantine.map((q) => (
            <li key={q.code}>
              {q.code}: {q.count}
            </li>
          ))}
        </ul>
      )}

      <h3>Approved works</h3>
      {status.works.length === 0 ? (
        <p>No approved works yet.</p>
      ) : (
        <>
          <table data-testid="essay-works">
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
          {status.worksTotal > status.works.length ? (
            <p>
              Showing {status.works.length} of {status.worksTotal} approved works.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
