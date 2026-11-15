-- 0016: the Essays project tab (H7, hub SPEC feature 6). Additive; ON CONFLICT keeps any row that
-- already exists (the preview seed inserts the same row).
INSERT INTO projects (slug, title, sort) VALUES ('essays', 'Essays', 0) ON CONFLICT DO NOTHING;
