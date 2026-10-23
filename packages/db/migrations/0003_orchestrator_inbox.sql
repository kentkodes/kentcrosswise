-- 0003: the orchestrator adds inbox items (DESIGN §4.2 step 7, §11 Q11).
-- When a PR needs the owner (critical change, incomplete merge-rules input, attempts exhausted,
-- issue text that fails the sanitizer), the orchestrator writes an approvals row and an
-- inbox_items row (kind 'approval', ref_table 'approvals', ref_id = the approval id). The console
-- (web_rw) closes the item when the owner decides. orch_rw only inserts: it cannot read or change
-- the owner's other inbox items (routing, calendar, contact matches).
GRANT INSERT ON inbox_items TO orch_rw;
