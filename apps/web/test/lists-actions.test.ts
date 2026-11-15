// The todo and idea actions are POST endpoints of their own: each checks the owner first and redirects with a
// fixed notice code (never the text). Failures log only the error class and SQLSTATE.
import { afterEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  withDb: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: f.redirect }));
vi.mock("@/server/owner", () => ({ requireOwner: f.requireOwner }));
// The '@/' alias does not resolve under this vitest setup, so each mock loads the real module by relative path.
vi.mock("@/server/db", async () => ({ ...(await import("../src/server/db")), withDb: f.withDb }));
vi.mock("../src/server/db", async () => ({ ...(await import("../src/server/db")), withDb: f.withDb }));
vi.mock("@/server/lists", async () => await import("../src/server/lists"));

import { addTodoAction, deleteTodoAction, setTodoDoneAction } from "../src/app/(owner)/todos/actions";
import { addIdeaAction, deleteIdeaAction, setIdeaStatusAction } from "../src/app/(owner)/ideas/actions";
import { ListInputError } from "../src/server/lists";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("todo actions", () => {
  it("stop before reading or storing anything when the caller is not the owner", async () => {
    f.requireOwner.mockRejectedValueOnce(new Error("NEXT_REDIRECT /api/auth/signin"));
    await expect(addTodoAction(form({ body: "private todo" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(f.requireOwner).toHaveBeenCalledOnce();
    expect(f.withDb).not.toHaveBeenCalled();
    expect(f.redirect).not.toHaveBeenCalled();
  });

  it("redirect with todo-empty for a whitespace-only add, and store nothing", async () => {
    f.withDb.mockImplementationOnce(async (_role: string, fn: (db: unknown) => Promise<unknown>) => {
      return fn({ query: async () => ({ rows: [] }) });
    });
    await addTodoAction(form({ body: "   " }));
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith("/todos?n=todo-empty");
  });

  it("add through web_rw and redirect with todo-added", async () => {
    f.withDb.mockResolvedValueOnce("todo-id");
    await addTodoAction(form({ body: "buy milk" }));
    expect(f.withDb).toHaveBeenCalledExactlyOnceWith("web_rw", expect.any(Function));
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith("/todos?n=todo-added");
  });

  it("mark done and undo redirect with the matching notice", async () => {
    f.withDb.mockResolvedValueOnce(undefined);
    await setTodoDoneAction(form({ id: "00000000-0000-0000-0000-000000000001", done: "true" }));
    expect(f.redirect).toHaveBeenLastCalledWith("/todos?n=todo-done");
    f.withDb.mockResolvedValueOnce(undefined);
    await setTodoDoneAction(form({ id: "00000000-0000-0000-0000-000000000001", done: "false" }));
    expect(f.redirect).toHaveBeenLastCalledWith("/todos?n=todo-open");
  });

  it("delete redirects with todo-deleted", async () => {
    f.withDb.mockResolvedValueOnce(undefined);
    await deleteTodoAction(form({ id: "00000000-0000-0000-0000-000000000001" }));
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith("/todos?n=todo-deleted");
  });

  it("maps a not-found todo to todo-not-found", async () => {
    f.withDb.mockRejectedValueOnce(new ListInputError("not-found"));
    await deleteTodoAction(form({ id: "nope" }));
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith("/todos?n=todo-not-found");
  });

  it("maps a DB failure to db-error, logging only the class and SQLSTATE", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.withDb.mockRejectedValueOnce(Object.assign(new Error("insert failed for private text"), { name: "Error", code: "42501" }));
    await addTodoAction(form({ body: "private todo" }));
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith("/todos?n=db-error");
    expect(log).toHaveBeenCalledExactlyOnceWith("[todos] Error 42501");
  });
});

describe("idea actions", () => {
  it("check the owner first", async () => {
    f.requireOwner.mockRejectedValueOnce(new Error("NEXT_REDIRECT /api/auth/signin"));
    await expect(setIdeaStatusAction(form({ id: "x", status: "done" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(f.withDb).not.toHaveBeenCalled();
  });

  it("add redirects with idea-added and a status change with idea-status", async () => {
    f.withDb.mockResolvedValueOnce("idea-id");
    await addIdeaAction(form({ body: "an idea" }));
    expect(f.redirect).toHaveBeenLastCalledWith("/ideas?n=idea-added");
    f.withDb.mockResolvedValueOnce(undefined);
    await setIdeaStatusAction(form({ id: "00000000-0000-0000-0000-000000000002", status: "dropped" }));
    expect(f.redirect).toHaveBeenLastCalledWith("/ideas?n=idea-status");
  });

  it("an unknown status redirects with invalid and never reaches a write", async () => {
    f.withDb.mockImplementationOnce(async (_role: string, fn: (db: unknown) => Promise<unknown>) => {
      return fn({ query: async () => ({ rows: [{ id: "x" }] }) });
    });
    await setIdeaStatusAction(form({ id: "00000000-0000-0000-0000-000000000002", status: "archived" }));
    expect(f.redirect).toHaveBeenLastCalledWith("/ideas?n=invalid");
  });

  it("delete redirects with idea-deleted", async () => {
    f.withDb.mockResolvedValueOnce(undefined);
    await deleteIdeaAction(form({ id: "00000000-0000-0000-0000-000000000002" }));
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith("/ideas?n=idea-deleted");
  });
});
