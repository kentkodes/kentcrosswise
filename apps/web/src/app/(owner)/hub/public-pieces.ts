// Splits the public text of the review screen (PL3) into plain text, placeholders and tappable words.

const TOKEN = /(\[(?:Person \d+|place|email|link|handle|phone|number)\])|([\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*)/gu;

type Piece = { kind: "text" | "placeholder" | "word"; value: string };

/** Splits public text into plain text, placeholders such as [Person 1] (never tappable) and words. */
export function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index;
    if (at > last) out.push({ kind: "text", value: text.slice(last, at) });
    out.push({ kind: m[1] ? "placeholder" : "word", value: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
  return out;
}
