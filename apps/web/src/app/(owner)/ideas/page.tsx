import type { Metadata } from "next";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { IDEA_STATUSES, listIdeas, MAX_ITEM_CHARS, type IdeaRow, type IdeaStatus } from "@/server/lists";
import { requireOwner } from "@/server/owner";
import { formatUtc } from "../format";
import { isSuccessNotice, noticeText } from "./notices";
import { OwnerFrame } from "../owner-frame";
import { Dot, Notice, Region } from "../owner-ui";
import s from "../owner.module.css";
import { addIdeaAction, deleteIdeaAction, setIdeaStatusAction } from "./actions";

export const metadata: Metadata = { title: "Ideas | Kentcrosswise" };

const STATUS_LABEL: Record<IdeaStatus, string> = { open: "Open", done: "Done", dropped: "Dropped" };

async function loadIdeas(): Promise<{ rows?: IdeaRow[]; problem?: string }> {
  try {
    const rows = await withDb("web_rw", (db) => listIdeas(db), { readOnly: true });
    return { rows };
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { problem: "The database is not connected yet." };
    console.error(`[ideas] ${dbErrorLabel(err)}`);
    return { problem: "The database is unavailable right now." };
  }
}

export default async function IdeasPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const code = (await searchParams).n;
  const notice = noticeText(code);
  const ok = isSuccessNotice(code);
  const { rows, problem } = await loadIdeas();

  return (
    <OwnerFrame title="Ideas" current="/hub">
      {notice ? (
        <Notice role={ok ? "status" : "alert"} tone={ok ? "ok" : "warn"}>
          {notice}
        </Notice>
      ) : null}

      <Region id="add" title="Add an idea" testId="add">
        <form action={addIdeaAction} className={`${s.pad} ${s.formRow}`}>
          <label className={s.fieldLabel}>
            Idea
            <input className={s.field} name="body" type="text" maxLength={MAX_ITEM_CHARS} required />
          </label>
          <button className={`${s.button} ${s.primary} ${s.tapTarget}`} type="submit">
            Add
          </button>
        </form>
      </Region>

      <Region id="list" title="Ideas" testId="ideas-region">
        {problem ? (
          <Notice role="alert" tone="warn">
            {problem}
          </Notice>
        ) : rows && rows.length === 0 ? (
          <p className={`${s.note} ${s.pad}`}>Nothing here yet.</p>
        ) : rows ? (
          <ol className={s.list} data-testid="ideas">
            {rows.map((idea) => (
              <li key={idea.id} data-idea-id={idea.id}>
                <p className={s.taskText}>{idea.body}</p>
                <p className={s.entryMeta}>
                  <time className={s.mono} dateTime={idea.createdAt}>
                    {formatUtc(idea.createdAt)}
                  </time>
                  <span className={s.statusWord}>
                    <Dot tone={idea.status === "done" ? "ok" : "idle"} />
                    <span data-field="status" className={s.emph}>
                      {STATUS_LABEL[idea.status]}
                    </span>
                  </span>
                  {idea.fromCapture ? <span className={s.note}>From a capture</span> : null}
                </p>
                <div className={s.formRow}>
                  <form action={setIdeaStatusAction} className={s.formRow}>
                    <input type="hidden" name="id" value={idea.id} />
                    {IDEA_STATUSES.map((status) => (
                      <button
                        key={status}
                        className={s.button}
                        type="submit"
                        name="status"
                        value={status}
                        disabled={idea.status === status}
                        aria-pressed={idea.status === status}
                      >
                        {STATUS_LABEL[status]}
                      </button>
                    ))}
                  </form>
                  <form action={deleteIdeaAction}>
                    <input type="hidden" name="id" value={idea.id} />
                    <button className={s.button} type="submit">
                      Delete
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </Region>
    </OwnerFrame>
  );
}
