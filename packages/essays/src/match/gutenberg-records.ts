import type { GutenbergEntry } from "../discovery/gutenberg";
import type { CatalogRecord } from "./match";

export const gutenbergEbookUrl = (id: number): string => `https://www.gutenberg.org/ebooks/${id}`;

/** Words that mark a collection or multi-volume book; such a record is never a stand-alone essay. */
const COLLECTION_MARKER = /\b(?:essays|works|complete|collected|selected|volumes?|and other)\b|\bvol\b\.?/i;

export function isCollectionTitle(title: string): boolean {
  return COLLECTION_MARKER.test(title);
}

/**
 * Splits the catalog author field ("Surname, Given, 1803-1882; Other, Name [Translator]"). Life dates
 * are kept (the matcher normalizes them). A person tagged Author or untagged is an author; a
 * Translator is returned separately; any other role (Editor, Illustrator, ...) is dropped.
 */
export function catalogAuthors(field: string): { authors: string[]; translator: string | null } {
  const authors: string[] = [];
  let translator: string | null = null;
  for (const part of field.split(";").map((p) => p.trim()).filter(Boolean)) {
    const role = /\[([^\]]*)\]\s*$/.exec(part)?.[1]?.trim().toLowerCase();
    const name = part.replace(/\s*\[[^\]]*\]\s*$/, "");
    if (role === undefined || role === "author") authors.push(name);
    else if (role === "translator") translator ??= name;
  }
  return { authors, translator };
}

/**
 * Catalog entries -> matcher records (metadata only). One record per author, so a co-authored book is
 * matched against each author. A translated record carries its translator, so the matcher drops it
 * (the catalog does not state translation rights). A record without a collection marker in its title
 * counts as stand-alone.
 */
export function gutenbergRecords(entries: readonly GutenbergEntry[]): CatalogRecord[] {
  return entries.flatMap((e) => {
    const { authors, translator } = catalogAuthors(e.author);
    return authors.map((author) => ({
      url: gutenbergEbookUrl(e.id),
      title: e.title,
      author,
      ...(translator && { translator }),
      standalone: !isCollectionTitle(e.title),
    }));
  });
}
