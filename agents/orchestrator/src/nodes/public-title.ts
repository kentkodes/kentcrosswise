// Public-title node, deterministic half (DESIGN §4.5, §11 Q8): what a (sub)task's proposed title
// and issue body may show in public. The model half is `ModelPlanner.plan` (planner.ts).
import type { CheckResult, Sanitizer } from "@kcw/core/sanitize";
import type { Plan } from "../graph/types";

export interface PublicText {
  /** `tasks.public_title`: the title if it passes every §4.5 rule, else null (the feed shows `Private task`). */
  publicTitle: string | null;
  /** The GitHub issue: a title that fails is `Private task`; the body is as proposed. */
  issue: { title: string; body: string };
  /** The body's content rules (`checkText`: §4.5 without the 60-character limit). Not ok: `issue_text` approval. */
  body: CheckResult;
}

export function publicText(plan: Plan, sanitizer: Sanitizer): PublicText {
  const titleOk = sanitizer.check(plan.title).ok;
  return {
    publicTitle: titleOk ? plan.title : null,
    issue: { title: sanitizer.publicTitle(plan.title), body: plan.body },
    body: sanitizer.checkText(plan.body),
  };
}
