// Social dashboard (H11): followers and views per account from daily snapshots, totals and change for the
// selected source, and the manual entry forms (accounts and snapshots). Owner only.
import type { Metadata } from "next";
import Link from "next/link";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import {
  PLATFORMS,
  SOURCES,
  inSource,
  listAccounts,
  parseSource,
  shortDay,
  todayUtc,
  totalsFor,
  type AccountRow,
  type Known,
  type Platform,
  type Source,
} from "@/server/social";
import { OwnerFrame } from "../owner-frame";
import { Notice, Region } from "../owner-ui";
import s from "../owner.module.css";
import { addAccountAction, deleteAccountAction, saveSnapshotAction } from "./actions";
import { isSuccessNotice, noticeText } from "./notices";
import c from "./social.module.css";
import { Trend } from "./trend";

export const metadata: Metadata = { title: "Social | Kentcrosswise" };

const PLATFORM_LABEL: Record<Platform, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };
const SOURCE_LABEL: Record<Source, string> = { all: "All", ...PLATFORM_LABEL };

const int = (n: number) => n.toLocaleString("en-US");

/**
 * A metric's latest known value. When it was entered for an older day than the row (the newest snapshot
 * left it empty), the day is shown in plain text next to it: "500 (12 Nov)".
 */
const metricCell = (k: Known | null, rowDay: string | null) =>
  k === null ? "none" : k.day === rowDay ? int(k.value) : `${int(k.value)} (${shortDay(k.day)})`;

/** A change as a plain signed number; "—" when there is nothing to compare with. */
function signed(n: number | null): string {
  if (n === null) return "—";
  if (n > 0) return `+${int(n)}`;
  if (n < 0) return `-${int(-n)}`;
  return "0";
}

function hrefFor(source: Source, extra: Record<string, string> = {}): string {
  return `/social?${new URLSearchParams({ source, ...extra }).toString()}`;
}

async function load(): Promise<{ accounts?: AccountRow[]; problem?: string }> {
  try {
    const accounts = await withDb("web_rw", (db) => listAccounts(db), { readOnly: true });
    return { accounts };
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { problem: noticeText("db-not-configured") };
    console.error(`[social] ${dbErrorLabel(err)}`);
    return { problem: noticeText("db-error") };
  }
}

export default async function SocialPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const params = await searchParams;
  const source = parseSource(params.source);
  const code = params.n;
  const notice = noticeText(code);
  const ok = isSuccessNotice(code);
  const deleteId = typeof params.delete === "string" ? params.delete : undefined;
  const { accounts, problem } = await load();
  const all = accounts ?? [];
  const shown = inSource(all, source);
  const totals = totalsFor(shown);
  const today = todayUtc();
  const pending = deleteId ? all.find((a) => a.id === deleteId) : undefined;
  // The forms need a working database: when the read failed, the notice above says so and the forms are hidden.
  const showForms = problem === undefined;

  return (
    <OwnerFrame title="Social" current="/hub">
      {notice ? (
        <Notice role={ok ? "status" : "alert"} tone={ok ? "ok" : "warn"}>
          {notice}
        </Notice>
      ) : null}
      {problem ? (
        <Notice role="alert" tone="warn">
          {problem}
        </Notice>
      ) : null}

      <nav aria-label="Source" className={c.sources}>
        <ul className={s.track}>
          {SOURCES.map((x) => (
            <li key={x}>
              <Link className={s.navLink} href={hrefFor(x)} aria-current={x === source ? "page" : undefined}>
                {SOURCE_LABEL[x]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <Region id="totals" title={source === "all" ? "Totals, all sources" : `Totals, ${SOURCE_LABEL[source]}`} testId="totals">
        <div className={`${s.pad} ${s.stack}`}>
          <div className={c.figures}>
            <div className={c.figure}>
              <span className={s.note}>Followers</span>
              <span className={c.figureValue} data-field="total-followers">
                {totals.followers === null ? "no numbers yet" : int(totals.followers)}
              </span>
            </div>
            <div className={c.figure}>
              <span className={s.note}>Views</span>
              <span className={c.figureValue} data-field="total-views">
                {totals.views === null ? "no numbers yet" : int(totals.views)}
              </span>
            </div>
          </div>
          <p className={s.note}>
            Each account counts its latest known followers and views, whichever day they were entered for. Rounded follower
            counts are added as entered. Days are UTC.
          </p>
        </div>
      </Region>

      <Region id="accounts" title="Accounts" testId="accounts">
        {problem ? null : shown.length === 0 ? (
          <p className={`${s.note} ${s.pad}`}>
            {all.length === 0 ? "No accounts yet. Add one below, then enter its numbers." : `No ${SOURCE_LABEL[source]} accounts yet.`}
          </p>
        ) : (
          <>
            <div className={s.tableWrap}>
              <table className={s.table} data-testid="account-table">
                <thead>
                  <tr>
                    <th scope="col">Platform</th>
                    <th scope="col">Handle</th>
                    <th scope="col" className={s.num}>
                      Followers
                    </th>
                    <th scope="col" className={s.num}>
                      Change
                    </th>
                    <th scope="col" className={s.num}>
                      Views
                    </th>
                    <th scope="col" className={s.num}>
                      Change
                    </th>
                    <th scope="col">Latest day</th>
                    <th scope="col">Numbers from</th>
                    <th scope="col">Followers trend</th>
                    <th scope="col">Remove</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((a) => (
                    <tr key={a.id} data-account-id={a.id}>
                      <td>{PLATFORM_LABEL[a.platform]}</td>
                      <th scope="row">{a.handle}</th>
                      <td className={s.num} data-field="followers">
                        {metricCell(a.followers, a.day)}
                        {a.followers && !a.followers.exact ? (
                          <span className={c.tag}>rounded</span>
                        ) : null}
                      </td>
                      <td className={s.num} data-field="followers-change">
                        {signed(a.change.followers)}
                      </td>
                      <td className={s.num} data-field="views">
                        {metricCell(a.views, a.day)}
                      </td>
                      <td className={s.num} data-field="views-change">
                        {signed(a.change.views)}
                      </td>
                      <td className={s.mono} data-field="day">
                        {a.day ?? "none"}
                      </td>
                      <td data-field="ingest">{a.ingest === "manual" ? "Manual" : "API"}</td>
                      <td>
                        <Trend values={a.trend} label={`Followers trend for ${a.handle}`} />
                      </td>
                      <td>
                        <Link className={s.button} href={hrefFor(source, { delete: a.id })}>
                          Delete
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={`${s.note} ${s.pad}`}>A dash means there is no earlier day to compare with. &quot;none&quot; means no number.</p>
          </>
        )}
      </Region>

      {pending ? (
        <Region id="confirm-delete" title="Delete account" testId="confirm-delete">
          <div className={`${s.pad} ${s.stack}`}>
            <p>
              Delete the {PLATFORM_LABEL[pending.platform]} account <span className={s.mono}>{pending.handle}</span> and its{" "}
              {int(pending.snapshots)} {pending.snapshots === 1 ? "snapshot" : "snapshots"}? This cannot be undone.
            </p>
            <div className={s.formRow}>
              <form action={deleteAccountAction}>
                <input type="hidden" name="account_id" value={pending.id} />
                <input type="hidden" name="source" value={source} />
                <button className={s.button} type="submit">
                  Delete account
                </button>
              </form>
              <Link className={s.button} href={hrefFor(source)}>
                Keep account
              </Link>
            </div>
          </div>
        </Region>
      ) : null}

      {showForms ? (
      <Region id="add-account" title="Add account" testId="add-account">
        <form action={addAccountAction} className={`${s.pad} ${s.stack}`}>
          <input type="hidden" name="source" value={source} />
          <div className={c.fields}>
            <label className={s.fieldLabel}>
              Platform
              <select className={s.field} name="platform" defaultValue="youtube" required>
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className={s.fieldLabel}>
              Handle
              <input
                className={s.field}
                name="handle"
                required
                maxLength={64}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
          </div>
          <p className={s.note}>Entered by hand (numbers from: Manual). A leading @ is removed.</p>
          <div>
            <button className={`${s.button} ${s.primary} ${s.tapTarget}`} type="submit">
              Add account
            </button>
          </div>
        </form>
      </Region>
      ) : null}

      {showForms ? (
      <Region id="snapshot" title="Enter numbers for a day" testId="snapshot">
        {all.length === 0 ? (
          <p className={`${s.note} ${s.pad}`}>Add an account first, then enter its numbers here.</p>
        ) : (
          <form action={saveSnapshotAction} className={`${s.pad} ${s.stack}`}>
            <input type="hidden" name="source" value={source} />
            <div className={c.fields}>
              <label className={s.fieldLabel}>
                Account
                <select className={s.field} name="account_id" required>
                  {all.map((a) => (
                    <option key={a.id} value={a.id}>
                      {PLATFORM_LABEL[a.platform]} {a.handle}
                    </option>
                  ))}
                </select>
              </label>
              <label className={s.fieldLabel}>
                Day (UTC)
                <input className={s.field} type="date" name="day" required defaultValue={today} max={today} />
              </label>
              <label className={s.fieldLabel}>
                Followers
                <input className={s.field} type="number" name="followers" min={0} step={1} inputMode="numeric" />
              </label>
              <label className={s.fieldLabel}>
                Views
                <input className={s.field} type="number" name="views" min={0} step={1} inputMode="numeric" />
              </label>
            </div>
            <label className={c.check}>
              <input type="checkbox" name="followers_rounded" />
              Followers are rounded (the platform shows a rounded count)
            </label>
            <p className={s.note}>
              An empty box stores no number for that field; leave both empty and nothing is saved. Saving the same account and
              day again replaces that day&apos;s numbers.
            </p>
            <div>
              <button className={`${s.button} ${s.primary} ${s.tapTarget}`} type="submit">
                Save numbers
              </button>
            </div>
          </form>
        )}
      </Region>
      ) : null}
    </OwnerFrame>
  );
}
