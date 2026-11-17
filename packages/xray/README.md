# @kcw/xray

The X-ray overlay registry for the public pages. `XRAY` in [src/index.ts](src/index.ts) maps a component id to `{label, tech, what, why}`; the `<Xray id>` wrapper and the header toggle live in `apps/web/src/app/(public)/_site/`. Public pages may import this package (D10, amended by D24 in [docs/DESIGN.md](../../docs/DESIGN.md)).

## Built: component labels

Every registry entry describes something that is built and shipped. An entry for a planned part is not added until that part exists, and its text is checked against the code of the public pages and DESIGN sections 0, 1, 4.5 and 5.

## Proposed scope: per-task evidence view (not built)

Owner direction 2026-11-17 ([DESIGN section 4.6](../../docs/DESIGN.md#46-personal-helper-and-published-task-records-owner-direction-2026-11-17)): the X-ray grows from component labels to per-task evidence. For a published task a visitor can open:

- the sanitized input and intended outcome;
- the actual tool calls and resulting changes;
- the checks that passed or failed;
- the recovery, if any, and anything still unresolved.

"Completed, checks passed, no recovery needed" is a complete record. The view shows actions, evidence and concise explanations, never raw model reasoning, and a record shows checks, not an accuracy percentage.

Boundaries of the proposal:

- Evidence comes from the sanitized public projection read through the `web_public` role, never from live private records and never from this registry. The registry stays a static description of built components.
- Withheld records are not viewable; only their count is public.
- No type, component or route for the evidence view exists yet. Its data model and per-route-kind checks are open points in [docs/OPEN-POINTS.md](../../docs/OPEN-POINTS.md).
