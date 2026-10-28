/** Jaro-Winkler similarity in [0, 1] (prefix scale 0.1, prefix capped at 4). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(b.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Dice coefficient of the two word sets (order and repeats ignored). */
export function tokenSetDice(a: string, b: string): number {
  const sa = new Set(a.split(" ").filter(Boolean));
  const sb = new Set(b.split(" ").filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared += 1;
  return (2 * shared) / (sa.size + sb.size);
}

const STOPWORDS = new Set(["a", "an", "the", "of", "on", "upon", "in", "to", "and", "for", "at", "with", "from", "by"]);

function content(s: string): string {
  const words = s.split(" ").filter(Boolean);
  const kept = words.filter((w) => !STOPWORDS.has(w));
  return (kept.length ? kept : words).join(" ");
}

/**
 * Title similarity for tier B, on normalized titles with filler words ("of", "on", "the") removed so
 * that "Of Studies" and "Of Solitude" do not match on the shared "of": the better of Jaro-Winkler and
 * token-set Dice.
 */
export function titleSimilarity(a: string, b: string): number {
  const ca = content(a);
  const cb = content(b);
  return Math.max(jaroWinkler(ca, cb), tokenSetDice(ca, cb));
}
