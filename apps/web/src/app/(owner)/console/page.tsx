// Boss console (P2-14): create tasks for the orchestrator, follow their status and events, and the
// pause switches. Owner only (the (owner) layout; actions check again).
import type { Metadata } from "next";
import { getFlags, listEvents, listTasks, MAX_TASK_TEXT, type EventRow, type Flags, type TaskRow } from "@/server/console";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { essayStatus, type EssayStatus } from "@/server/essay-status";
import { orchestratorQueue } from "@/server/orchestrator-queue";
import { requireOwner } from "@/server/owner";
import { formatUtc } from "../format";
import { OwnerFrame } from "../owner-frame";
import { Dot, Notice, Region } from "../owner-ui";
import s from "../owner.module.css";
import { noticeText } from "../notices";
import { taskTone } from "../tones";
import { EssayStatusSection } from "./essay-status";
import { createTaskAction, resendTaskAction, setFlagAction } from "./actions";

export const metadata: Metadata = { title: "Boss console | Kentcrosswise" };

type Data = { tasks: TaskRow[]; events: EventRow[]; flags: Flags; essays: EssayStatus };

async function load(): Promise<{ data?: Data; problem?: string }> {
  try {
    const data = await withDb(
      "web_rw",
      async (db) => {
        const [tasks, flags] = [await listTasks(db), await getFlags(db)];
        return { tasks, flags, events: await listEvents(db, tasks.map((t) => t.id)), essays: await essayStatus(db) };
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

// One switch: running is ok, paused is warn. The button name and the status word are unchanged.
function FlagSwitch({ name, label, on }: { name: keyof Flags; label: string; on: boolean }) {
  return (
    <form action={setFlagAction} className={s.split}>
      <input type="hidden" name="key" value={name} />
      <input type="hidden" name="value" value={on ? "false" : "true"} />
      <span className={s.lineLabel}>
        <span className={s.statusWord}>
          <Dot tone={on ? "warn" : "ok"} />
          <span className={s.label}>{label}</span>
        </span>
        <span className={s.muted}>{on ? "paused" : "running"}</span>
      </span>
      <button className={s.button} type="submit">
        {on ? `Resume ${label.toLowerCase()}` : `Pause ${label.toLowerCase()}`}
      </button>
    </form>
  );
}

function TaskItem({ task, events, canSend }: { task: TaskRow; events: EventRow[]; canSend: boolean }) {
  const showResend = task.status === "queued" && canSend && !task.isDocs;
  return (
    <li id={`task-${task.id}`} data-task-id={task.id}>
      <p className={s.taskMeta}>
        <span className={s.mono}>#{task.id}</span>
        <span className={s.statusWord}>
          <Dot tone={taskTone(task.status)} />
          <span data-field="status" className={s.emph}>
            {task.status}
          </span>
        </span>
        {task.waitingOn ? <span>waiting on {task.waitingOn}</span> : null}
        <span data-field="visibility">{task.isPrivate ? "private" : "public"}</span>
        {task.publicTitle ? <span>public title: {task.publicTitle}</span> : null}
        {task.prNumber ? <span>PR #{task.prNumber}</span> : null}
        {task.parentId ? <span>{task.isDocs ? `docs update after #${task.parentId}` : `subtask of #${task.parentId}`}</span> : null}
      </p>
      <p data-field="text" className={s.taskText}>
        {task.ownerText}
      </p>
      {events.length > 0 || showResend ? (
        <div className={s.endRow}>
          {events.length > 0 ? (
            <details className={s.events}>
              <summary className={s.summary}>{events.length} events</summary>
              <ol className={s.eventList}>
                {events.map((e) => (
                  <li key={e.id}>
                    <time className={s.mono} dateTime={e.ts}>
                      {formatUtc(e.ts)}
                    </time>
                    <strong className={s.emph}>{e.agent}</strong>
                    <span className={s.muted}>{e.type.replaceAll("_", " ")}</span>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          {showResend ? (
            <form action={resendTaskAction} className={s.end}>
              <input type="hidden" name="task_id" value={task.id} />
              <button className={s.button} type="submit">
                Resend to orchestrator
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export default async function ConsolePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const notice = noticeText((await searchParams).n);
  const { data, problem } = await load();
  const queue = orchestratorQueue();

  return (
    <OwnerFrame title="Boss console" current="/console">
      {notice ? <Notice role="status" tone="ok">{notice}</Notice> : null}
      {!queue.enabled ? <Notice tone="warn">The orchestrator queue is not configured here: tasks are saved but not sent.</Notice> : null}
      {problem ? (
        <Notice role="alert" tone="warn">
          {problem}
        </Notice>
      ) : data ? (
        <>
          <Region id="switches" title="Switches">
            <FlagSwitch name="agents_paused" label="Agents" on={data.flags.agents_paused} />
            <FlagSwitch name="pipelines_paused" label="Pipelines" on={data.flags.pipelines_paused} />
          </Region>

          <Region id="new-task" title="New task">
            <form action={createTaskAction} className={`${s.pad} ${s.stack}`}>
              <label className={s.fieldLabel} htmlFor="owner_text">
                Task
              </label>
              <textarea id="owner_text" className={s.field} name="owner_text" rows={4} required maxLength={MAX_TASK_TEXT} />
              <label className={s.check}>
                <input type="checkbox" name="is_private" defaultChecked /> Private (the public office shows &quot;Private task&quot;)
              </label>
              <div>
                <button className={`${s.button} ${s.primary}`} type="submit">
                  Create task
                </button>
              </div>
            </form>
          </Region>

          <Region id="tasks" title="Tasks" aside={<span className={s.count}>{data.tasks.length}</span>}>
            {data.tasks.length === 0 ? <p className={`${s.note} ${s.pad}`}>No tasks yet.</p> : null}
            <ol data-testid="tasks" reversed className={s.list}>
              {data.tasks.map((t) => (
                <TaskItem key={t.id} task={t} events={data.events.filter((e) => e.taskId === t.id)} canSend={queue.enabled} />
              ))}
            </ol>
          </Region>

          <EssayStatusSection status={data.essays} />
        </>
      ) : null}
    </OwnerFrame>
  );
}
