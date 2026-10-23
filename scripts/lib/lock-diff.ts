// lockDiff for merge-rules (P2-13): direct dependencies added per workspace package, computed
// from the `importers` section of pnpm-lock.yaml on the base branch vs the PR.
//
// pnpm writes the lockfile itself, in a fixed layout, so this reads only that layout (no YAML
// dependency): `importers:` at column 0, importer paths at 2 spaces, dependency fields at 4,
// package names at 6, `specifier:`/`version:` at 8. Since pnpm 11 the file can hold several YAML
// documents (`---`); every `importers:` block is read. Anything unexpected inside a dependency
// field throws, so CI fails instead of producing a diff that misses a package (fail closed).
//
// What counts as the package (its "identity"), so an allowlisted name cannot smuggle in something else:
// - registry dependency `zod: ^4`                    -> `zod`
// - npm alias `zod: npm:evil@^1`                     -> `evil` (the package actually installed)
// - workspace package (`workspace:` / `link:`)       -> skipped (not an npm dependency)
// - any other source (git, tarball URL, file:, link: outside the workspace)
//                                                    -> `<name> (<specifier>)`, which matches no allowlist entry
import type { MergeInputLockDiff } from "@kcw/core/merge-input";

/** The importer fields that hold direct dependencies. */
const DEP_FIELDS = new Set(["dependencies", "devDependencies", "optionalDependencies"]);

export interface LockDep {
  /** Key in the importer (the name the code imports). */
  name: string;
  specifier: string;
  version: string;
}

export class LockfileFormatError extends Error {
  override name = "LockfileFormatError";
}

/** Strips YAML single or double quotes from a plain scalar as pnpm writes it. */
function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return JSON.parse(s) as string;
  return s;
}

/** `key: value` or `key:` at a known indent; keys may be quoted. */
function keyValue(body: string): { key: string; value: string } | undefined {
  const m = /^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^\s'"][^:]*?):(?:\s+(.*))?$/.exec(body);
  if (!m) return undefined;
  return { key: unquote(m[1]!), value: (m[2] ?? "").trim() };
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * Direct dependencies per importer path (`.`, `agents/report`, ...), from every `importers:` block.
 * An importer with no dependencies (`agents/merge-rules: {}`) maps to an empty list.
 */
export function parseLockImporters(text: string): Map<string, LockDep[]> {
  const lines = text.split(/\r?\n/);
  const out = new Map<string, LockDep[]>();
  let sawImporters = false;
  let inImporters = false;
  let importer: string | undefined;
  let field: string | undefined;
  let dep: Partial<LockDep> | undefined;

  const flush = (lineNo: number) => {
    if (dep === undefined) return;
    if (importer === undefined || dep.name === undefined || dep.specifier === undefined || dep.version === undefined) {
      throw new LockfileFormatError(`pnpm-lock.yaml line ${lineNo}: dependency without specifier and version`);
    }
    out.get(importer)!.push(dep as LockDep);
    dep = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = indentOf(line);
    const body = line.trim();

    if (indent === 0) {
      flush(lineNo);
      inImporters = body === "importers:";
      if (inImporters) sawImporters = true;
      importer = undefined;
      field = undefined;
      continue;
    }
    if (!inImporters) continue;

    if (indent === 2) {
      flush(lineNo);
      const kv = keyValue(body);
      if (!kv || (kv.value !== "" && kv.value !== "{}")) {
        throw new LockfileFormatError(`pnpm-lock.yaml line ${lineNo}: unexpected importer entry`);
      }
      importer = kv.key;
      if (!out.has(importer)) out.set(importer, []);
      field = undefined;
      continue;
    }
    if (importer === undefined) throw new LockfileFormatError(`pnpm-lock.yaml line ${lineNo}: entry outside an importer`);

    if (indent === 4) {
      flush(lineNo);
      const kv = keyValue(body);
      if (!kv) throw new LockfileFormatError(`pnpm-lock.yaml line ${lineNo}: unexpected importer field`);
      field = DEP_FIELDS.has(kv.key) ? kv.key : undefined;
      if (field !== undefined && kv.value !== "" && kv.value !== "{}") {
        throw new LockfileFormatError(`pnpm-lock.yaml line ${lineNo}: unexpected inline ${kv.key}`);
      }
      continue;
    }
    if (field === undefined) continue; // e.g. dependenciesMeta, packageManagerDependencies

    if (indent === 6) {
      flush(lineNo);
      const kv = keyValue(body);
      if (!kv || kv.value !== "") throw new LockfileFormatError(`pnpm-lock.yaml line ${lineNo}: unexpected dependency entry`);
      dep = { name: kv.key };
      continue;
    }
    if (indent === 8 && dep !== undefined) {
      const kv = keyValue(body);
      if (kv?.key === "specifier") dep.specifier = unquote(kv.value);
      else if (kv?.key === "version") dep.version = unquote(kv.value);
      else throw new LockfileFormatError(`pnpm-lock.yaml line ${lineNo}: unexpected dependency property`);
      continue;
    }
    throw new LockfileFormatError(`pnpm-lock.yaml line ${lineNo}: unexpected indentation`);
  }
  flush(lines.length);
  if (!sawImporters) throw new LockfileFormatError("pnpm-lock.yaml has no importers section");
  return out;
}

/** The package a dependency really installs (see the header); `undefined` for workspace packages. */
export function depIdentity(d: LockDep): string | undefined {
  if (d.specifier.startsWith("workspace:")) return undefined;
  const alias = /^npm:((?:@[^/@\s]+\/)?[^/@\s]+)(?:@.*)?$/.exec(d.specifier);
  if (alias) return alias[1];
  if (d.specifier.startsWith("npm:")) return `${d.name} (${d.specifier})`;
  // Registry dependencies have a semver range or tag as specifier and a version (plus peer suffix) without a protocol.
  const registry = !/^(link|file|git|git\+[a-z]+|github|gitlab|bitbucket|https?|catalog|jsr):/.test(d.specifier) &&
    !d.specifier.includes("/") && !/^(link|file):/.test(d.version) && !/^https?:/.test(d.version);
  return registry ? d.name : `${d.name} (${d.specifier})`;
}

/** Direct dependencies added by the PR per importer, plus every direct dependency of the base (for merge-rules' new-service rule). */
export function computeLockDiff(baseText: string, headText: string): MergeInputLockDiff {
  const base = parseLockImporters(baseText);
  const head = parseLockImporters(headText);

  const identities = (deps: readonly LockDep[]) =>
    new Set(deps.map(depIdentity).filter((x): x is string => x !== undefined));

  const added: MergeInputLockDiff["added"] = [];
  for (const [importer, deps] of head) {
    const before = identities(base.get(importer) ?? []);
    for (const name of identities(deps)) {
      if (!before.has(name)) added.push({ importer, name });
    }
  }
  added.sort((a, b) => a.importer.localeCompare(b.importer) || a.name.localeCompare(b.name));

  const existing = new Set<string>();
  for (const deps of base.values()) for (const n of identities(deps)) existing.add(n);
  return { added, existing: [...existing].sort() };
}

/** A short step-summary section (names only). */
export function lockDiffMarkdown(diff: MergeInputLockDiff): string {
  const lines = ["### Lockfile: new direct dependencies", ""];
  if (diff.added.length === 0) lines.push("None.");
  else for (const d of diff.added) lines.push(`- \`${d.name}\` in \`${d.importer}\``);
  return `${lines.join("\n")}\n`;
}
