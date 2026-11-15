"use server";
// Todo actions. Each checks the owner first: a server action is a POST endpoint of its own, not covered by the
// (owner) layout. Each ends in a redirect with a fixed notice code (never the todo text).
import { redirect } from "next/navigation";
import { withDb } from "@/server/db";
import { addTodo, deleteTodo, setTodoDone } from "@/server/lists";
import { requireOwner } from "@/server/owner";
import { todoFailure, type NoticeCode } from "./notices";

async function run(fn: () => Promise<void>, ok: NoticeCode): Promise<NoticeCode> {
  try {
    await fn();
    return ok;
  } catch (err) {
    return todoFailure(err);
  }
}

export async function addTodoAction(formData: FormData): Promise<void> {
  await requireOwner();
  const notice = await run(async () => {
    await withDb("web_rw", (db) => addTodo(db, formData.get("body")));
  }, "todo-added");
  redirect(`/todos?n=${notice}`);
}

export async function setTodoDoneAction(formData: FormData): Promise<void> {
  await requireOwner();
  const done = formData.get("done") === "true";
  const notice = await run(async () => {
    await withDb("web_rw", (db) => setTodoDone(db, formData.get("id"), done));
  }, done ? "todo-done" : "todo-open");
  redirect(`/todos?n=${notice}`);
}

export async function deleteTodoAction(formData: FormData): Promise<void> {
  await requireOwner();
  const notice = await run(async () => {
    await withDb("web_rw", (db) => deleteTodo(db, formData.get("id")));
  }, "todo-deleted");
  redirect(`/todos?n=${notice}`);
}
