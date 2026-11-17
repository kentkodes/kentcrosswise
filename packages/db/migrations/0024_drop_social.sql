-- 0024: the social feature is removed (owner decision, 2026-11-17). Drops the two tables created in 0001:
-- social_snapshots first (it references social_accounts), then social_accounts. The owner's follower and
-- view numbers are not kept. The grants on both tables (web_rw in 0001) go with them, and nothing else
-- refers to them: no view, function, trigger or other foreign key.
SET LOCAL lock_timeout = '5s';
DROP TABLE social_snapshots;
DROP TABLE social_accounts;
