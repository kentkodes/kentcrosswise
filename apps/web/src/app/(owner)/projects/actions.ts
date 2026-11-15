"use server";
// Project actions. Each checks the owner first (a server action is its own POST endpoint). Each ends in a redirect
// with a fixed notice code (never a title). The slug and the tab must be slugs (lower case letters, digits and
// hyphens, at most 80 characters): anything else is refused before any SQL, and a bad tab is dropped.
import { redirect } from "next/navigation";
import { withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import { addProject, deleteProject, isValidSlug, moveProject, renameProject } from "@/server/projects";
import { projectFailure, type NoticeCode } from "./notices";

function tabOf(formData: FormData): string {
  const tab = formData.get("tab");
  return isValidSlug(tab) ? tab : "";
}

function projectsPath(tab: string, notice: NoticeCode): string {
  const query = new URLSearchParams();
  if (tab !== "") query.set("tab", tab);
  query.set("n", notice);
  return `/projects?${query.toString()}`;
}

export async function addProjectAction(formData: FormData): Promise<void> {
  await requireOwner();
  let tab = tabOf(formData);
  let notice: NoticeCode;
  try {
    // The new project becomes the selected tab.
    tab = await withDb("web_rw", (db) => addProject(db, formData.get("title")));
    notice = "project-added";
  } catch (err) {
    notice = projectFailure(err);
  }
  redirect(projectsPath(tab, notice));
}

export async function renameProjectAction(formData: FormData): Promise<void> {
  await requireOwner();
  const tab = tabOf(formData);
  const slug = formData.get("slug");
  let notice: NoticeCode;
  if (!isValidSlug(slug)) {
    notice = "invalid";
  } else {
    try {
      await withDb("web_rw", (db) => renameProject(db, slug, formData.get("title")));
      notice = "project-renamed";
    } catch (err) {
      notice = projectFailure(err);
    }
  }
  redirect(projectsPath(tab, notice));
}

export async function moveProjectAction(formData: FormData): Promise<void> {
  await requireOwner();
  const tab = tabOf(formData);
  const slug = formData.get("slug");
  let notice: NoticeCode;
  if (!isValidSlug(slug)) {
    notice = "invalid";
  } else {
    try {
      await withDb("web_rw", (db) => moveProject(db, slug, formData.get("direction")));
      notice = "project-moved";
    } catch (err) {
      notice = projectFailure(err);
    }
  }
  redirect(projectsPath(tab, notice));
}

export async function deleteProjectAction(formData: FormData): Promise<void> {
  await requireOwner();
  const tab = tabOf(formData);
  const slug = formData.get("slug");
  let notice: NoticeCode;
  if (!isValidSlug(slug)) {
    notice = "invalid";
  } else {
    try {
      await withDb("web_rw", (db) => deleteProject(db, slug));
      notice = "project-deleted";
    } catch (err) {
      notice = projectFailure(err);
    }
  }
  redirect(projectsPath(tab, notice));
}
