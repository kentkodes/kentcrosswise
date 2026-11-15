import type { Metadata } from "next";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { listTodos, MAX_ITEM_CHARS, type TodoRow } from "@/server/lists";
import { requireOwner } from "@/server/owner";
import { formatUtc } from "../format";
import { isSuccessNotice, noticeText } from "./notices";
import { OwnerFrame } from "../owner-frame";
import { Dot, Notice, Region } from "../owner-ui";
import s from "../owner.module.css";
import { addTodoAction, deleteTodoAction, setTodoDoneAction } from "./actions";

export const metadata: Metadata = { title: "Todos | Kentcrosswise" };

async function loadTodos(): Promise<{ rows?: TodoRow[]; problem?: string }> {
  try {
    const rows = await withDb("web_rw", (db) => listTodos(db), { readOnly: true });
    return { rows };
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { problem: "The database is not connected yet." };
    console.error(`[todos] ${dbErrorLabel(err)}`);
    return { problem: "The database is unavailable right now." };
  }
}

export default async function TodosPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const code = (await searchParams).n;
  const notice = noticeText(code);
  const ok = isSuccessNotice(code);
  const { rows, problem } = await loadTodos();

  return (
    <OwnerFrame title="Todos" current="/hub">
      {notice ? (
        <Notice role={ok ? "status" : "alert"} tone={ok ? "ok" : "warn"}>
          {notice}
        </Notice>
      ) : null}

      <Region id="add" title="Add a todo" testId="add">
        <form action={addTodoAction} className={`${s.pad} ${s.formRow}`}>
          <label className={s.fieldLabel}>
            Todo
            <input className={s.field} name="body" type="text" maxLength={MAX_ITEM_CHARS} required />
          </label>
          <button className={`${s.button} ${s.primary} ${s.tapTarget}`} type="submit">
            Add
          </button>
        </form>
      </Region>

      <Region id="list" title="Todos" testId="todos-region">
        {problem ? (
          <Notice role="alert" tone="warn">
            {problem}
          </Notice>
        ) : rows && rows.length === 0 ? (
          <p className={`${s.note} ${s.pad}`}>Nothing here yet.</p>
        ) : rows ? (
          <ol className={s.list} data-testid="todos">
            {rows.map((t) => (
              <li key={t.id} data-todo-id={t.id}>
                <p className={s.taskText}>{t.body}</p>
                <p className={s.entryMeta}>
                  <time className={s.mono} dateTime={t.createdAt}>
                    {formatUtc(t.createdAt)}
                  </time>
                  <span className={s.statusWord}>
                    <Dot tone={t.done ? "ok" : "idle"} />
                    <span data-field="status" className={s.emph}>
                      {t.done ? "Done" : "Open"}
                    </span>
                  </span>
                  {t.fromCapture ? <span className={s.note}>From a capture</span> : null}
                </p>
                <div className={s.formRow}>
                  <form action={setTodoDoneAction}>
                    <input type="hidden" name="id" value={t.id} />
                    <input type="hidden" name="done" value={t.done ? "false" : "true"} />
                    <button className={s.button} type="submit">
                      {t.done ? "Undo" : "Mark done"}
                    </button>
                  </form>
                  <form action={deleteTodoAction}>
                    <input type="hidden" name="id" value={t.id} />
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
