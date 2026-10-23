// Usage panel (P2-15): model usage and cost by agent, model and day, plus GitHub Actions minutes.
// Owner only (the (owner) layout). Read-only: the range is a GET form, there are no actions.
import type { Metadata } from "next";
import Link from "next/link";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { formatUsd, parseRange, usageSummary, type UsageGroup, type UsageSummary } from "@/server/usage";

export const metadata: Metadata = { title: "Usage | Kentcrosswise" };

async function load(range: { from: string; to: string }): Promise<{ data?: UsageSummary; problem?: string }> {
  try {
    return { data: await withDb("web_rw", (db) => usageSummary(db, range), { readOnly: true }) };
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { problem: "The database is not connected yet." };
    console.error(`[usage] ${dbErrorLabel(err)}`);
    return { problem: "The database is unavailable right now." };
  }
}

const int = (n: number) => n.toLocaleString("en-US");

function Cost({ group }: { group: UsageGroup }) {
  return (
    <>
      {formatUsd(group.costUsd)}
      {group.costUsd !== null && group.unpricedEvents > 0 ? <> (+{int(group.unpricedEvents)} with no price)</> : null}
    </>
  );
}

function GroupTable({ id, title, label, groups }: { id: string; title: string; label: string; groups: UsageGroup[] }) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {groups.length === 0 ? (
        <p>No model usage in this range.</p>
      ) : (
        <table data-testid={id}>
          <thead>
            <tr>
              <th scope="col">{label}</th>
              <th scope="col">Events</th>
              <th scope="col">Input tokens</th>
              <th scope="col">Output tokens</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key} data-key={g.key}>
                <th scope="row">{g.key}</th>
                <td>{int(g.events)}</td>
                <td>{int(g.inputTokens)}</td>
                <td>{int(g.outputTokens)}</td>
                <td data-field="cost">
                  <Cost group={g} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default async function UsagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const range = parseRange(params.from, params.to);
  const { data, problem } = await load(range);

  return (
    <main>
      <h1>Usage</h1>
      <p>
        <Link href="/console">Boss console</Link> · <Link href="/inbox">Inbox</Link>
      </p>
      <form method="get">
        <label>
          From <input type="date" name="from" defaultValue={range.from} required />
        </label>{" "}
        <label>
          To <input type="date" name="to" defaultValue={range.to} required />
        </label>{" "}
        <button type="submit">Show</button>
      </form>
      {range.adjusted ? <p role="status">That range was not valid; showing the last 30 days.</p> : null}
      <p>
        Days are UTC. Cost uses the stored cost of an event when there is one, otherwise the model price in effect on the
        event&apos;s day. Events without either show &quot;no price&quot;.
      </p>
      {problem ? (
        <p role="alert">{problem}</p>
      ) : data ? (
        <>
          <section aria-labelledby="totals">
            <h2 id="totals">
              Totals {data.range.from} to {data.range.to}
            </h2>
            <p data-testid="model-total">
              Model usage: {int(data.total.events)} events, {int(data.total.inputTokens)} input and{" "}
              {int(data.total.outputTokens)} output tokens, cost <Cost group={data.total} />
              {data.total.costUsd === null && data.total.unpricedEvents > 0 ? <> ({int(data.total.unpricedEvents)} events)</> : null}
            </p>
            <p data-testid="actions-minutes">
              Actions minutes ($0, public standard runners): {data.actions.minutes.toFixed(2)} min over {int(data.actions.runs)}{" "}
              runs
            </p>
          </section>
          <GroupTable id="by-agent" title="By agent" label="Agent" groups={data.byAgent} />
          <GroupTable id="by-model" title="By model" label="Model" groups={data.byModel} />
          <GroupTable id="by-day" title="By day" label="Day (UTC)" groups={data.byDay} />
        </>
      ) : null}
    </main>
  );
}
