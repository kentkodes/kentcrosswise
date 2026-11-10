import { gutenbergId } from "../discovery/gutenberg";
import { MATCHER_VERSION, type Candidate, type SeedInput } from "./match";

const cell = (s: string) => s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
/** Plain code-point order: the same on every machine and locale. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const uncell = (s: string) => s.replace(/\\\|/g, "|").trim();

/** The only columns the table may carry: public catalog and seed metadata plus the two review cells. */
export const REVIEW_COLUMNS = [
  "Seed key",
  "Seed title",
  "Seed author",
  "Seed PD likely",
  "Candidate title",
  "Candidate author",
  "Candidate URL",
  "Gutenberg id",
  "Tier",
  "Score",
  "Translation",
  "Action",
  "QA verdict",
  "Owner decision",
] as const;

export const AUTO_APPROVE_ACTION = "auto-approve (tier A, public domain likely)";

/** The hand-filled cells of one row; kept across a re-plan. */
export interface ReviewCells {
  qa: string;
  owner: string;
}

export const reviewKey = (seedKey: string, url: string): string => `${seedKey}\n${url}`;

export interface ReviewOptions {
  /** Date the catalog was fetched (YYYY-MM-DD). */
  catalogDate?: string;
  matcherVersion?: string;
  /** Cells from an earlier table, by `reviewKey`, so a re-plan does not erase QA or owner entries. */
  previous?: ReadonlyMap<string, ReviewCells>;
}

function idOf(url: string): string {
  try {
    return String(gutenbergId(url) ?? "");
  } catch {
    return "";
  }
}

/**
 * The metadata-only review table (Markdown) for the owner or QA: provenance header, counts, then one
 * row per candidate. Built from seed and catalog metadata alone; nothing is fetched. Deterministic.
 */
export function renderReviewTable(
  seeds: readonly SeedInput[],
  candidates: readonly Candidate[],
  sourceName: string,
  options: ReviewOptions = {},
): string {
  const byId = new Map(seeds.map((s) => [s.id, s]));
  const withCandidate = new Set(candidates.map((c) => c.seedId));
  const count = (f: (c: Candidate) => boolean) => candidates.filter(f).length;
  const pd = seeds.filter((s) => s.publicDomainLikely === true).length;

  const rows = [...candidates]
    .sort((a, b) =>
      cmp(a.tier, b.tier) || cmp(byId.get(a.seedId)?.title ?? "", byId.get(b.seedId)?.title ?? "") || b.score - a.score || cmp(a.url, b.url) ||
      cmp(byId.get(a.seedId)?.seedKey ?? "", byId.get(b.seedId)?.seedKey ?? ""))
    .map((c) => {
      const s = byId.get(c.seedId);
      const seedKey = s?.seedKey ?? "";
      const note = c.translator ? `translation by ${c.translator}${c.translationYear ? ` (${c.translationYear})` : ""}` : "";
      const action = c.autoApprove ? AUTO_APPROVE_ACTION : "needs review";
      const kept = options.previous?.get(reviewKey(seedKey, c.url));
      return `| ${[
        cell(seedKey), cell(s?.title ?? "?"), cell(s?.author ?? "?"),
        s?.publicDomainLikely === null ? "unknown" : String(s?.publicDomainLikely),
        cell(c.title), cell(c.author), cell(c.url), idOf(c.url), c.tier, c.score.toFixed(2), cell(note), action,
        cell(kept?.qa ?? ""), cell(kept?.owner ?? ""),
      ].join(" | ")} |`;
    });

  return [
    `# Seed to source match review: ${cell(sourceName)}`,
    "",
    "Metadata only: titles, authors, URLs and scores. No essay text was fetched. Nothing is fetched until a link is approved.",
    "",
    `Catalog fetched: ${options.catalogDate ?? "unknown"}`,
    `Matcher version: ${options.matcherVersion ?? MATCHER_VERSION}`,
    "",
    "| Measure | Count |",
    "|---|---|",
    `| Seeds checked | ${seeds.length} |`,
    `| Seeds marked public domain likely | ${pd} |`,
    `| Seeds with a candidate | ${withCandidate.size} |`,
    `| Tier A candidates | ${count((c) => c.tier === "A")} |`,
    `| Tier A auto-approvable | ${count((c) => c.autoApprove)} |`,
    `| Tier B candidates (review) | ${count((c) => c.tier === "B")} |`,
    `| Seeds staying link-only | ${seeds.length - withCandidate.size} |`,
    "",
    "Owner decision: write `approve` or `reject` in the last column; blank leaves the link proposed (tier A auto rows are approved on apply).",
    "",
    `| ${REVIEW_COLUMNS.join(" | ")} |`,
    `|${REVIEW_COLUMNS.map(() => "---").join("|")}|`,
    ...rows,
    "",
  ].join("\n");
}

/** One data row of a review table, as read back. */
export interface ReviewRow {
  seedKey: string;
  candidateTitle: string;
  candidateAuthor: string;
  url: string;
  gutenbergId: string;
  tier: string;
  score: string;
  translation: string;
  action: string;
  qa: string;
  owner: string;
}

const splitRow = (line: string): string[] =>
  line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map(uncell);

/** Reads the rows of a table made by `renderReviewTable`. Throws on a changed header or a malformed row. */
export function parseReviewTable(markdown: string): ReviewRow[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith("| Seed key |"));
  if (start < 0) throw new Error("review_table_missing");
  if (splitRow(lines[start] as string).join("|") !== REVIEW_COLUMNS.join("|")) throw new Error("review_table_columns");
  const rows: ReviewRow[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const c = splitRow(line);
    if (c.length !== REVIEW_COLUMNS.length) throw new Error("review_table_row");
    rows.push({
      seedKey: c[0]!, candidateTitle: c[4]!, candidateAuthor: c[5]!, url: c[6]!, gutenbergId: c[7]!,
      tier: c[8]!, score: c[9]!, translation: c[10]!, action: c[11]!, qa: c[12]!, owner: c[13]!,
    });
  }
  return rows;
}

/** The hand-filled cells of an existing table, for a re-plan. */
export function reviewCells(rows: readonly ReviewRow[]): Map<string, ReviewCells> {
  return new Map(rows.filter((r) => r.qa || r.owner).map((r) => [reviewKey(r.seedKey, r.url), { qa: r.qa, owner: r.owner }]));
}
