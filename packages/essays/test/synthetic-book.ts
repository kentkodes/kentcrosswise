import { createHash } from "node:crypto";

const VOCAB = [
  "river", "lantern", "copper", "meadow", "silent", "garden", "letter", "winter", "harbor", "candle", "orchard", "pencil",
  "window", "marble", "velvet", "thunder", "pepper", "compass", "feather", "ladder", "mirror", "anchor", "basket", "cabin",
  "dagger", "eagle", "falcon", "glacier", "hammer", "island", "jacket", "kettle", "ledger", "magnet", "needle", "oyster",
  "parcel", "quarry", "rabbit", "saddle", "timber", "umbrella", "valley", "wagon", "yonder", "zephyr", "amber", "harvest",
];

/**
 * Test text shaped like a Gutenberg book: `base`'s header (through its START marker line) and footer (from its END
 * marker), with `n` synthetic words between them, after `lead`. Each tag gives its own words, so two different tags
 * give texts far below the near-duplicate threshold. Deterministic; contains no essay text of the fixtures.
 */
export function syntheticBook(base: string, tag: string, n = 420, lead = ""): string {
  const head = base.slice(0, base.indexOf("\n", base.indexOf("*** START")) + 1);
  const tail = base.slice(base.indexOf("*** END"));
  const words: string[] = [];
  for (let i = 0; i < n; i++) {
    const byte = createHash("sha256").update(`${tag}:${i}`).digest()[0] ?? 0;
    words.push(VOCAB[byte % VOCAB.length] ?? "river");
  }
  return `${head}\n${lead}${words.join(" ")}\n\n${tail}`;
}
