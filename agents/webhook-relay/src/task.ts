// Task resolution (DESIGN §4.3): agent branches are named `kcw/task-<id>` (Developer playbook);
// `task-<id>` (the thread id) is accepted too. `<id>` is `tasks.id`, a positive integer.

const BRANCH = /^(?:refs\/heads\/)?(?:kcw\/)?task-([1-9]\d{0,15})$/;

/** The task id encoded in a branch name or `refs/heads/...` ref, or null. */
export function taskIdFromBranch(ref: string | null | undefined): number | null {
  if (typeof ref !== "string") return null;
  const m = BRANCH.exec(ref);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) ? id : null;
}
