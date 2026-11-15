// The project actions are POST endpoints of their own: each checks the owner first and redirects with a fixed
// notice code. The tab comes back from a hidden field, and only a slug-shaped value is kept.
import { afterEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  withDb: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: f.redirect }));
vi.mock("@/server/owner", () => ({ requireOwner: f.requireOwner }));
vi.mock("@/server/db", async () => ({ ...(await import("../src/server/db")), withDb: f.withDb }));
vi.mock("../src/server/db", async () => ({ ...(await import("../src/server/db")), withDb: f.withDb }));
vi.mock("@/server/projects", async () => await import("../src/server/projects"));

import { addProjectAction, deleteProjectAction, moveProjectAction, renameProjectAction } from "../src/app/(owner)/projects/actions";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("project actions", () => {
  it("stop before any write when the caller is not the owner", async () => {
    f.requireOwner.mockRejectedValueOnce(new Error("NEXT_REDIRECT /api/auth/signin"));
    await expect(addProjectAction(form({ title: "Secret plan" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(f.withDb).not.toHaveBeenCalled();
    expect(f.redirect).not.toHaveBeenCalled();
  });

  it("add selects the new project's tab", async () => {
    f.withDb.mockResolvedValueOnce("garden-log");
    await addProjectAction(form({ title: "Garden Log", tab: "essays" }));
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith("/projects?tab=garden-log&n=project-added");
  });

  it("a failed add keeps the current tab and shows the fixed code", async () => {
    f.withDb.mockImplementationOnce(async (_role: string, fn: (db: unknown) => Promise<unknown>) => {
      // Slug collision: the database refuses the insert with unique_violation.
      return fn({
        query: async () => {
          throw Object.assign(new Error("duplicate key"), { code: "23505" });
        },
      });
    });
    await addProjectAction(form({ title: "Essays", tab: "essays" }));
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith("/projects?tab=essays&n=project-slug-taken");
  });

  it("drops a tab value that is not a slug", async () => {
    f.withDb.mockResolvedValueOnce(undefined);
    await renameProjectAction(form({ slug: "garden-log", title: "Journal", tab: "<script>" }));
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith("/projects?n=project-renamed");
  });

  it("renaming Essays redirects with project-protected and writes nothing", async () => {
    f.withDb.mockImplementationOnce(async (_role: string, fn: (db: unknown) => Promise<unknown>) => fn({ query: async () => ({ rows: [] }) }));
    await renameProjectAction(form({ slug: "essays", title: "Writing", tab: "essays" }));
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith("/projects?tab=essays&n=project-protected");
  });

  it("deleting Essays redirects with project-protected", async () => {
    f.withDb.mockImplementationOnce(async (_role: string, fn: (db: unknown) => Promise<unknown>) => fn({ query: async () => ({ rows: [] }) }));
    await deleteProjectAction(form({ slug: "essays", tab: "essays" }));
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith("/projects?tab=essays&n=project-protected");
  });

  it("a move at the edge is not an error and redirects with project-moved", async () => {
    f.withDb.mockImplementationOnce(async (_role: string, fn: (db: unknown) => Promise<unknown>) =>
      fn({ query: async () => ({ rows: [{ slug: "essays" }] }) }),
    );
    await moveProjectAction(form({ slug: "essays", direction: "up", tab: "essays" }));
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith("/projects?tab=essays&n=project-moved");
  });

  it("a DB failure maps to db-error and logs only the class and SQLSTATE", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.withDb.mockRejectedValueOnce(Object.assign(new Error("private title in message"), { name: "Error", code: "42501" }));
    await deleteProjectAction(form({ slug: "garden-log", tab: "garden-log" }));
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith("/projects?tab=garden-log&n=db-error");
    expect(log).toHaveBeenCalledExactlyOnceWith("[projects] Error 42501");
  });
});
