// Boss console (P2-14): create tasks for the orchestrator, follow their status and events, and the
// pause switches. Owner only (the (owner) layout; actions check again).
import type { Metadata } from "next";
import Link from "next/link";
import { getFlags, listEvents, listTasks, MAX_TASK_TEXT, type EventRow, type Flags, type TaskRow } from "@/server/console";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { orchestratorQueue } from "@/server/orchestrator-queue";
import { noticeText } from "../notices";
import { createTaskAction, resendTaskAction, setFlagAction } from "./actions";

export const metadata: Metadata = { title: "Boss console | Kentcrosswise" };

type Data = { tasks: TaskRow[]; events: EventRow[]; flags: Flags };

async function load(): Promise<{ data?: Data; problem?: string }> {
  try {
    const data = await withDb(
      "web_rw",
      async (db) => {
        const [tasks, flags] = [await listTasks(db), await getFlags(db)];
        return { tasks, flags, events: await listEvents(db, tasks.map((t) => t.id)) };
      },
      { readOnly: true },
    );
    return { data };
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { problem: "The database is not connected yet." };
    console.error(`[console] ${dbErrorLabel(err)}`);
    return { problem: "The database is unavailable right now." };
  }
}

function FlagSwitch({ name, label, on }: { name: keyof Flags; label: string; on: boolean }) {
  return (
    <form action={setFlagAction}>
      <input type="hidden" name="key" value={name} />
      <input type="hidden" name="value" value={on ? "false" : "true"} />
      <span>
        {label}: <strong>{on ? "paused" : "running"}</strong>{" "}
      </span>
      <button type="submit">{on ? `Resume ${label.toLowerCase()}` : `Pause ${label.toLowerCase()}`}</button>
    </form>
  );
}

function TaskItem({ task, events, canSend }: { task: TaskRow; events: EventRow[]; canSend: boolean }) {
  return (
    <li id={`task-${task.id}`} data-task-id={task.id}>
      <p>
        <strong>#{task.id}</strong> <span data-field="status">{task.status}</span>
        {task.waitingOn ? <> (waiting on {task.waitingOn})</> : null} ·{" "}
        <span data-field="visibility">{task.isPrivate ? "private" : "public"}</span>
        {task.publicTitle ? <> · public title: {task.publicTitle}</> : null}
        {task.prNumber ? <> · PR #{task.prNumber}</> : null}
        {task.parentId ? <> · subtask of #{task.parentId}</> : null}
      </p>
      <p data-field="text">{task.ownerText}</p>
      {task.status === "queued" && canSend ? (
        <form action={resendTaskAction}>
          <input type="hidden" name="task_id" value={task.id} />
          <button type="submit">Resend to orchestrator</button>
        </form>
      ) : null}
      {events.length > 0 ? (
        <details>
          <summary>{events.length} events</summary>
          <ol>
            {events.map((e) => (
              <li key={e.id}>
                <time dateTime={e.ts}>{e.ts.replace("T", " ").slice(0, 19)}</time> {e.agent} {e.type.replaceAll("_", " ")}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </li>
  );
}

export default async function ConsolePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const notice = noticeText((await searchParams).n);
  const { data, problem } = await load();
  const queue = orchestratorQueue();

  return (
    <main>
      <h1>Boss console</h1>
      <p>
        <Link href="/inbox">Inbox</Link> · <Link href="/console/usage">Usage</Link> · <Link href="/hub">Hub</Link>
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      {!queue.enabled ? <p>The orchestrator queue is not configured here: tasks are saved but not sent.</p> : null}
      {problem ? (
        <p role="alert">{problem}</p>
      ) : data ? (
        <>
          <section aria-labelledby="switches">
            <h2 id="switches">Switches</h2>
            <FlagSwitch name="agents_paused" label="Agents" on={data.flags.agents_paused} />
            <FlagSwitch name="pipelines_paused" label="Pipelines" on={data.flags.pipelines_paused} />
          </section>

          <section aria-labelledby="new-task">
            <h2 id="new-task">New task</h2>
            <form action={createTaskAction}>
              <p>
                <label htmlFor="owner_text">Task</label>
                <br />
                <textarea id="owner_text" name="owner_text" rows={4} cols={60} required maxLength={MAX_TASK_TEXT} />
              </p>
              <p>
                <label>
                  <input type="checkbox" name="is_private" defaultChecked /> Private (the public office shows
                  &quot;Private task&quot;)
                </label>
              </p>
              <button type="submit">Create task</button>
            </form>
          </section>

          <section aria-labelledby="tasks">
            <h2 id="tasks">Tasks</h2>
            {data.tasks.length === 0 ? <p>No tasks yet.</p> : null}
            <ol data-testid="tasks" reversed>
              {data.tasks.map((t) => (
                <TaskItem key={t.id} task={t} events={data.events.filter((e) => e.taskId === t.id)} canSend={queue.enabled} />
              ))}
            </ol>
          </section>
        </>
      ) : null}
    </main>
  );
}
