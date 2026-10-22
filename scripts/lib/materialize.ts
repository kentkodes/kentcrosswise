// Makes the OpenNext server bundle self-contained without symlinks.
//
// OpenNext mirrors pnpm's layout: node_modules/.pnpm/<pkg>/node_modules/* plus symlinks between
// them. Terraform's archive_file follows symlinks, so the zip holds plain copies, and a copied
// package no longer finds its pnpm siblings (Node resolves upward from the copy, not from the
// link target): "Cannot find module '@swc/helpers/...'" on cold start. Fix: replace every symlink
// with a copy of its target, then hoist pnpm's hidden hoist directory (.pnpm/node_modules/*) to the
// bundle's root node_modules, where every package finds it by walking up.
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import path from "node:path";

function findSymlinks(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) out.push(full);
    else if (entry.isDirectory()) findSymlinks(full, out);
  }
  return out;
}

/** Replaces each symlink under `root` by a copy of its target. Returns how many were replaced. */
export function materializeSymlinks(root: string): number {
  let replaced = 0;
  // Targets are pnpm package directories (real dirs), but loop in case a copy brought links along.
  for (let pass = 0; pass < 10; pass++) {
    const links = findSymlinks(root);
    if (links.length === 0) return replaced;
    for (const link of links) {
      const target = path.resolve(path.dirname(link), readlinkSync(link));
      if (!existsSync(target)) throw new Error(`broken symlink in bundle: ${path.relative(root, link)}`);
      const rel = path.relative(root, target);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`symlink points outside the bundle: ${path.relative(root, link)}`);
      }
      rmSync(link, { recursive: false, force: true });
      cpSync(target, link, { recursive: true, verbatimSymlinks: true });
      replaced += 1;
    }
  }
  throw new Error("symlinks did not converge after 10 passes");
}

/** Copies node_modules/.pnpm/node_modules/* to node_modules/* (names not already there). */
export function hoistPnpm(root: string): string[] {
  const hidden = path.join(root, "node_modules", ".pnpm", "node_modules");
  if (!existsSync(hidden)) return [];
  const hoisted: string[] = [];
  const names: string[] = [];
  for (const entry of readdirSync(hidden)) {
    if (entry.startsWith("@")) {
      for (const sub of readdirSync(path.join(hidden, entry))) names.push(`${entry}/${sub}`);
    } else {
      names.push(entry);
    }
  }
  for (const name of names) {
    const dest = path.join(root, "node_modules", ...name.split("/"));
    if (existsSync(dest)) continue;
    const src = path.join(hidden, ...name.split("/"));
    if (lstatSync(src).isSymbolicLink()) throw new Error(`materialize symlinks before hoisting (${name})`);
    cpSync(src, dest, { recursive: true });
    hoisted.push(name);
  }
  return hoisted.sort();
}

function pkgVersion(dir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/**
 * After hoisting, node_modules/.pnpm only duplicates the root copies. Deletes it when every
 * package inside matches the hoisted name and version; otherwise keeps it and returns the conflicts.
 */
export function prunePnpm(root: string): { pruned: boolean; conflicts: string[] } {
  const store = path.join(root, "node_modules", ".pnpm");
  if (!existsSync(store)) return { pruned: false, conflicts: [] };
  const conflicts: string[] = [];
  for (const entry of readdirSync(store)) {
    const nm = path.join(store, entry, "node_modules");
    if (entry === "node_modules" || !existsSync(nm)) continue;
    for (const first of readdirSync(nm)) {
      const names = first.startsWith("@") ? readdirSync(path.join(nm, first)).map((s) => `${first}/${s}`) : [first];
      for (const name of names) {
        const nested = pkgVersion(path.join(nm, ...name.split("/")));
        const hoisted = pkgVersion(path.join(root, "node_modules", ...name.split("/")));
        if (nested !== hoisted) conflicts.push(`${name} ${nested ?? "?"} vs hoisted ${hoisted ?? "missing"}`);
      }
    }
  }
  if (conflicts.length > 0) return { pruned: false, conflicts };
  rmSync(store, { recursive: true, force: true });
  return { pruned: true, conflicts };
}
