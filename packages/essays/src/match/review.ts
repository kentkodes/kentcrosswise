import type { Candidate, SeedInput } from "./match";

const cell = (s: string) => s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

/**
 * The metadata-only review table (Markdown) for the owner or QA: counts, then one row per candidate.
 * Built from seed and catalog metadata alone; nothing is fetched. Output is deterministic.
 */
export function renderReviewTable(seeds: readonly SeedInput[], candidates: readonly Candidate[], sourceName: string): string {
  const byId = new Map(seeds.map((s) => [s.id, s]));
  const withCandidate = new Set(candidates.map((c) => c.seedId));
  const count = (f: (c: Candidate) => boolean) => candidates.filter(f).length;
  const pd = seeds.filter((s) => s.publicDomainLikely === true).length;

  const rows = [...candidates]
    .sort((a, b) => a.tier.localeCompare(b.tier) || (byId.get(a.seedId)?.title ?? "").localeCompare(byId.get(b.seedId)?.title ?? "") || b.score - a.score || a.url.localeCompare(b.url))
    .map((c) => {
      const s = byId.get(c.seedId);
      const note = c.translator ? `translation by ${c.translator}${c.translationYear ? ` (${c.translationYear})` : ""}` : "";
      const action = c.autoApprove ? "auto-approve (tier A, public domain likely)" : "needs review";
      return `| ${cell(s?.title ?? "?")} | ${cell(s?.author ?? "?")} | ${s?.publicDomainLikely === null ? "unknown" : String(s?.publicDomainLikely)} | ${cell(c.title)} | ${cell(c.author)} | ${cell(c.url)} | ${c.tier} | ${c.score.toFixed(2)} | ${cell(note)} | ${action} |`;
    });

  return [
    `# Seed to source match review: ${cell(sourceName)}`,
    "",
    "Metadata only: titles, authors, URLs and scores. No essay text was fetched. Nothing is fetched until a link is approved.",
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
    "| Seed title | Seed author | Seed PD likely | Candidate title | Candidate author | Candidate URL | Tier | Score | Translation | Action |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
