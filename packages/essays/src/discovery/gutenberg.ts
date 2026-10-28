export interface GutenbergEntry { id: number; title: string; author: string; language: string }

/** RFC 4180-style CSV; catalog metadata only. Malformed quoting fails the run closed. */
export function parseGutenbergCatalog(csv: string): GutenbergEntry[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]!;
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === '"') {
      if (field || closed) throw new Error("catalog_bad_csv");
      quoted = true;
    } else if (c === ",") { row.push(field); field = ""; closed = false; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      row.push(field); if (row.some(Boolean)) rows.push(row); row = []; field = ""; closed = false;
    } else { if (closed) throw new Error("catalog_bad_csv"); field += c; }
  }
  if (quoted) throw new Error("catalog_bad_csv");
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift()?.map((s) => s.replace(/^\uFEFF/, "").trim());
  if (!header) throw new Error("catalog_missing_header");
  const indexes = ["Text#", "Type", "Title", "Authors", "Language"].map((k) => header.indexOf(k));
  if (indexes.some((i) => i < 0)) throw new Error("catalog_missing_header");
  const [idCol, typeCol, titleCol, authorCol, langCol] = indexes as [number, number, number, number, number];
  return rows.flatMap((r) => {
    if (r.length !== header.length) throw new Error("catalog_bad_row");
    const id = Number(r[idCol]);
    if (!Number.isSafeInteger(id) || id < 1 || r[typeCol] !== "Text") return [];
    const language = r[langCol]!.trim();
    return language === "en" ? [{ id, title: r[titleCol]!, author: r[authorCol]!, language }] : [];
  });
}

/** A catalog identity URL, not permission to download ebook text from the human website. */
export function gutenbergId(url: string): number | null {
  const u = new URL(url);
  const match = /^\/ebooks\/([1-9]\d*)$/.exec(u.pathname);
  return u.protocol === "https:" && u.hostname === "www.gutenberg.org" && !u.search && match ? Number(match[1]) : null;
}
