-- 0026: public text inputs for the public log (slice PL3, DESIGN §4.6).
--
-- One row per entry once the span-proposal call (apps/web/src/server/public-spans.ts) has run: its outcome, the
-- people and places it proposed and whether the text is about another person's private matters, plus the words the
-- owner added on the /hub review screen. The public text itself is not stored: it is computed from the entry text
-- with `createRecordRedactor` (@kcw/core/sanitize), and publication (PL4) will snapshot it. The proposed and added
-- terms are names and places taken from private text, so this table is private: web_rw only, no public view.
-- Owner terms only ever grow (the review screen can add a replacement, never remove one).
SET LOCAL lock_timeout = '5s';

CREATE TABLE entry_public (
  entry_id      uuid PRIMARY KEY REFERENCES entries (id) ON DELETE CASCADE,
  spans_state   text NOT NULL CHECK (spans_state IN ('ok', 'cap', 'too-long', 'failed', 'invalid', 'timeout')),
  people        text[] NOT NULL DEFAULT '{}',
  places        text[] NOT NULL DEFAULT '{}',
  private_other boolean NOT NULL DEFAULT false,
  owner_people  text[] NOT NULL DEFAULT '{}',
  owner_places  text[] NOT NULL DEFAULT '{}',
  proposed_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (spans_state = 'ok' OR (people = '{}' AND places = '{}' AND NOT private_other)),
  CHECK (cardinality(people) <= 50 AND cardinality(places) <= 50 AND cardinality(owner_people) <= 50 AND cardinality(owner_places) <= 50)
);

GRANT SELECT, INSERT, UPDATE ON entry_public TO web_rw;
