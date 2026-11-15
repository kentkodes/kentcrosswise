import type { Metadata } from "next";
import Link from "next/link";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import {
  type EssaySummary,
  essaySummary,
  ESSAYS_SLUG,
  isValidSlug,
  listProjects,
  PROJECT_TITLE_MAX,
  type ProjectRow,
} from "@/server/projects";
import { isSuccessNotice, noticeText } from "./notices";
import { OwnerFrame } from "../owner-frame";
import { Notice, Region } from "../owner-ui";
import s from "../owner.module.css";
import { addProjectAction, deleteProjectAction, moveProjectAction, renameProjectAction } from "./actions";

export const metadata: Metadata = { title: "Projects | Kentcrosswise" };

interface Loaded {
  projects?: ProjectRow[];
  summary?: EssaySummary;
  problem?: string;
}

// The list and the Essays summary (read-only, from the essays and ratings tables).
async function load(): Promise<Loaded> {
  try {
    return await withDb(
      "web_rw",
      async (db) => ({ projects: await listProjects(db), summary: await essaySummary(db) }),
      { readOnly: true },
    );
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { problem: "The database is not connected yet." };
    console.error(`[projects] ${dbErrorLabel(err)}`);
    return { problem: "The database is unavailable right now." };
  }
}

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const params = await searchParams;
  const notice = noticeText(params.n);
  const ok = isSuccessNotice(params.n);
  // A ?tab= that is not a slug is ignored, like an unknown one: the page shows the first project.
  const asked = isValidSlug(params.tab) ? params.tab : undefined;
  const { projects, summary, problem } = await load();
  // Unknown or missing ?tab= falls back to the first project.
  const selected = projects?.find((p) => p.slug === asked) ?? projects?.[0];
  const tabSlug = selected?.slug ?? "";

  return (
    <OwnerFrame title="Projects" current="/projects">
      {notice ? (
        <Notice role={ok ? "status" : "alert"} tone={ok ? "ok" : "warn"}>
          {notice}
        </Notice>
      ) : null}

      {problem ? (
        <Notice role="alert" tone="warn">
          {problem}
        </Notice>
      ) : projects ? (
        <>
          <nav aria-label="Projects" className={s.navScroll}>
            <ul className={s.track} data-testid="project-tabs">
              {projects.map((p) => (
                <li key={p.slug}>
                  <Link className={s.navLink} href={`/projects?tab=${p.slug}`} aria-current={p.slug === tabSlug ? "page" : undefined}>
                    {p.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {selected ? (
            <Region id="tab" title={selected.title} testId="tab">
              {selected.slug === ESSAYS_SLUG ? (
                <div className={`${s.pad} ${s.stack}`}>
                  {summary ? (
                    <p className={s.note} data-testid="essay-summary">
                      {summary.essays} {summary.essays === 1 ? "essay" : "essays"} in the library, {summary.rated} rated.
                    </p>
                  ) : null}
                  <div>
                    <Link className={s.label} href="/essays">
                      Open the library
                    </Link>
                  </div>
                </div>
              ) : (
                <p className={`${s.note} ${s.pad}`}>No page for this project yet.</p>
              )}
            </Region>
          ) : null}

          <Region id="manage" title="Manage projects" testId="manage">
            <form action={addProjectAction} className={`${s.pad} ${s.formRow}`}>
              <input type="hidden" name="tab" value={tabSlug} />
              <label className={s.fieldLabel}>
                New project title
                <input className={s.field} name="title" type="text" maxLength={PROJECT_TITLE_MAX} required />
              </label>
              <button className={`${s.button} ${s.primary} ${s.tapTarget}`} type="submit">
                Add project
              </button>
            </form>

            <ol className={s.list} data-testid="projects">
              {projects.map((p, i) => {
                const protectedProject = p.slug === ESSAYS_SLUG;
                return (
                  <li key={p.slug} data-project={p.slug}>
                    <p className={s.label}>{p.title}</p>
                    <p className={s.note}>Tab address: {p.slug}</p>
                    {protectedProject ? (
                      <p className={s.note}>Built in: this tab cannot be renamed or deleted.</p>
                    ) : (
                      <form action={renameProjectAction} className={s.formRow}>
                        <input type="hidden" name="tab" value={tabSlug} />
                        <input type="hidden" name="slug" value={p.slug} />
                        <label className={s.fieldLabel}>
                          Rename
                          <input className={s.field} name="title" type="text" defaultValue={p.title} maxLength={PROJECT_TITLE_MAX} required />
                        </label>
                        <button className={s.button} type="submit" aria-label={`Rename project ${p.title}`}>
                          Rename
                        </button>
                      </form>
                    )}
                    <div className={s.formRow}>
                      <form action={moveProjectAction} className={s.formRow}>
                        <input type="hidden" name="tab" value={tabSlug} />
                        <input type="hidden" name="slug" value={p.slug} />
                        <button
                          className={s.button}
                          type="submit"
                          name="direction"
                          value="up"
                          disabled={i === 0}
                          aria-label={`Move up project ${p.title}`}
                        >
                          Move up
                        </button>
                        <button
                          className={s.button}
                          type="submit"
                          name="direction"
                          value="down"
                          disabled={i === projects.length - 1}
                          aria-label={`Move down project ${p.title}`}
                        >
                          Move down
                        </button>
                        {protectedProject ? null : (
                          <button className={s.button} type="submit" formAction={deleteProjectAction} aria-label={`Delete project ${p.title}`}>
                            Delete
                          </button>
                        )}
                      </form>
                    </div>
                  </li>
                );
              })}
            </ol>
          </Region>
        </>
      ) : null}
    </OwnerFrame>
  );
}
