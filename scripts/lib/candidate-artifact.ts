// The candidate-preview artifact (AR1 slice 2): what the credential-free `candidate-build` job of ci.yml
// produces and what the trusted preview-trusted.yml workflow accepts. The artifact is DATA from candidate
// code: nothing in it is executed by a privileged job. This file is the whole validation (pure functions
// over bytes; the CLI is scripts/verify-candidate-artifact.ts, tests in scripts/test/candidate-artifact.test.ts).
//
// Archive format: a plain (uncompressed) pax tar of `.open-next/`, written by `tar --format=pax` (pnpm
// paths in a real build have components longer than ustar allows).
// The artifact upload zip already compresses it, and an uncompressed tar needs no decompression-bomb
// handling. Only regular files and directories are accepted. A pax extended header ('x') is accepted only
// for the next entry and only with the keys path, mtime, atime, ctime; global pax headers, GNU long names
// and every link/device/fifo entry are rejected.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CANDIDATE_ARTIFACT = "candidate-preview";
export const DB_FILE = "preview-db.sql";
export const WEB_FILE = "preview-web.tar";
export const MANIFEST_FILE = "candidate-manifest.json";
/** The tar's single top-level directory, extracted into apps/web/. */
export const OPEN_NEXT_DIR = ".open-next";

/**
 * Limits. A current preview build is about 72 MB in 3,700 entries with the longest path at 157
 * characters (measured 2026-11-14), so these are roughly 5x headroom on entries and 7x on bytes.
 */
export const LIMITS = {
  maxEntries: 20_000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  maxTarBytes: 600 * 1024 * 1024,
  maxPathLength: 1024,
  maxSegmentLength: 255,
  maxPaxBytes: 8 * 1024,
  maxDbBytes: 64 * 1024 * 1024,
} as const;

export interface CandidateManifest {
  schema: 1;
  repository_id: number;
  pr_number: number;
  head_sha: string;
  run_id: number;
  run_attempt: number;
  files: Record<string, string>;
}

export interface ExpectedCandidate {
  repositoryId: number;
  prNumber: number;
  headSha: string;
  runId: number;
}

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HASHED_FILES = [DB_FILE, WEB_FILE] as const;

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function positiveInt(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`manifest: ${what} must be a positive integer`);
  return value;
}

/** Parses an environment value such as REPOSITORY_ID into a positive safe integer. */
export function parseId(raw: string | undefined, what: string): number {
  if (raw === undefined || !/^[1-9][0-9]{0,15}$/.test(raw.trim())) throw new Error(`${what} must be a positive integer`);
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n)) throw new Error(`${what} must be a positive integer`);
  return n;
}

export function parseSha(raw: string | undefined, what: string): string {
  if (raw === undefined || !SHA1.test(raw.trim())) throw new Error(`${what} must be a 40-character lowercase hex SHA`);
  return raw.trim();
}

export function buildManifest(input: Omit<CandidateManifest, "schema" | "files">, files: Record<string, Uint8Array>): CandidateManifest {
  const hashes: Record<string, string> = {};
  for (const name of HASHED_FILES) {
    const data = files[name];
    if (!data) throw new Error(`missing ${name}`);
    hashes[name] = sha256Hex(data);
  }
  return { schema: 1, ...input, files: hashes };
}

export function parseManifest(text: string): CandidateManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("manifest is not JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("manifest must be a JSON object");
  const m = raw as Record<string, unknown>;
  const keys = Object.keys(m).sort().join(",");
  if (keys !== "files,head_sha,pr_number,repository_id,run_attempt,run_id,schema") throw new Error("manifest has unexpected or missing keys");
  if (m.schema !== 1) throw new Error("manifest schema must be 1");
  if (typeof m.head_sha !== "string" || !SHA1.test(m.head_sha)) throw new Error("manifest: head_sha must be a 40-character lowercase hex SHA");
  const files = m.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) throw new Error("manifest: files must be an object");
  if (Object.keys(files).sort().join(",") !== [...HASHED_FILES].sort().join(",")) {
    throw new Error(`manifest: files must list exactly ${HASHED_FILES.join(" and ")}`);
  }
  const hashes: Record<string, string> = {};
  for (const [name, hash] of Object.entries(files)) {
    if (typeof hash !== "string" || !SHA256.test(hash)) throw new Error(`manifest: files.${name} must be a sha256 hex digest`);
    hashes[name] = hash;
  }
  return {
    schema: 1,
    repository_id: positiveInt(m.repository_id, "repository_id"),
    pr_number: positiveInt(m.pr_number, "pr_number"),
    head_sha: m.head_sha,
    run_id: positiveInt(m.run_id, "run_id"),
    run_attempt: positiveInt(m.run_attempt, "run_attempt"),
    files: hashes,
  };
}

/**
 * Checks the manifest against what the trusted workflow derived from the event and the API, and every
 * file's sha256 against the manifest. `files` holds the bytes of the two hashed files.
 */
export function verifyManifest(manifest: CandidateManifest, expected: ExpectedCandidate, files: Record<string, Uint8Array>): void {
  if (manifest.repository_id !== expected.repositoryId) throw new Error("manifest repository_id does not match this repository");
  if (manifest.pr_number !== expected.prNumber) throw new Error("manifest pr_number does not match the pull request");
  if (manifest.head_sha !== expected.headSha) throw new Error("manifest head_sha does not match the triggering run");
  if (manifest.run_id !== expected.runId) throw new Error("manifest run_id does not match the triggering run");
  for (const name of HASHED_FILES) {
    const data = files[name];
    if (!data) throw new Error(`missing ${name}`);
    if (sha256Hex(data) !== manifest.files[name]) throw new Error(`${name} does not match its manifest sha256`);
  }
}

/** The SQL dump is text a driver will execute: bounded, UTF-8, no NUL. */
export function checkDbDump(data: Uint8Array): void {
  if (data.length === 0) throw new Error(`${DB_FILE} is empty`);
  if (data.length > LIMITS.maxDbBytes) throw new Error(`${DB_FILE} is larger than ${LIMITS.maxDbBytes} bytes`);
  if (data.includes(0)) throw new Error(`${DB_FILE} contains a NUL byte`);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error(`${DB_FILE} is not valid UTF-8`);
  }
}

// ---------- tar ----------

export interface TarEntry {
  /** Normalized path without a trailing slash, e.g. ".open-next/server-functions/default/index.mjs". */
  path: string;
  type: "file" | "dir";
  /** Offset and size of the file data inside the tar buffer (files only). */
  offset: number;
  size: number;
}

const BLOCK = 512;

function cstr(buf: Uint8Array, start: number, length: number): string {
  let end = start;
  const limit = start + length;
  while (end < limit && buf[end] !== 0) end++;
  return Buffer.from(buf.subarray(start, end)).toString("latin1");
}

function isZeroBlock(buf: Uint8Array, at: number): boolean {
  for (let i = at; i < at + BLOCK; i++) if (buf[i] !== 0) return false;
  return true;
}

function octal(buf: Uint8Array, start: number, length: number, what: string): number {
  if ((buf[start]! & 0x80) !== 0) throw new Error(`tar: ${what} uses a base-256 value`);
  const text = cstr(buf, start, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error(`tar: ${what} is not an octal number`);
  return parseInt(text, 8);
}

function checksumOk(buf: Uint8Array, at: number): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : buf[at + i]!;
  const text = cstr(buf, at + 148, 8).trim();
  return /^[0-7]+$/.test(text) && parseInt(text, 8) === sum;
}

/** Validates an entry path; returns its segments. Rejects anything that could escape or surprise. */
export function entrySegments(raw: string): string[] {
  if (raw === "") throw new Error("tar: empty entry name");
  if (raw.length > LIMITS.maxPathLength) throw new Error("tar: entry name too long");
  if (raw.startsWith("/")) throw new Error(`tar: absolute path rejected: ${JSON.stringify(raw)}`);
  // eslint-disable-next-line no-control-regex
  if (/[\\:\u0000-\u001f\u007f]/.test(raw)) throw new Error(`tar: entry name has a backslash, colon or control character: ${JSON.stringify(raw)}`);
  if (Buffer.byteLength(raw) > LIMITS.maxPathLength) throw new Error("tar: entry name too long");
  const trimmed = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const segments = trimmed.split("/");
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") throw new Error(`tar: path segment not allowed: ${JSON.stringify(raw)}`);
    if (Buffer.byteLength(s) > LIMITS.maxSegmentLength) throw new Error("tar: path component too long");
  }
  if (segments[0] !== OPEN_NEXT_DIR) throw new Error(`tar: entry outside ${OPEN_NEXT_DIR}/: ${JSON.stringify(raw)}`);
  return segments;
}

const PAX_KEYS = new Set(["path", "mtime", "atime", "ctime"]);

/** Parses a pax extended header strictly ("<len> key=value\n" records, exact lengths); returns the path override. */
export function parsePax(data: Uint8Array): { path?: string } {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("tar: pax header is not valid UTF-8");
  }
  const bytes = Buffer.from(data);
  const out: { path?: string } = {};
  const seenKeys = new Set<string>();
  let pos = 0;
  while (pos < bytes.length) {
    let i = pos;
    while (i < bytes.length && bytes[i]! >= 0x30 && bytes[i]! <= 0x39) i++;
    if (i === pos || i - pos > 5 || bytes[i] !== 0x20 || (bytes[pos] === 0x30)) throw new Error("tar: malformed pax record length");
    const len = Number(bytes.subarray(pos, i).toString("latin1"));
    if (len < i - pos + 4 || pos + len > bytes.length || bytes[pos + len - 1] !== 0x0a) throw new Error("tar: pax record length does not match its content");
    const body = bytes.subarray(i + 1, pos + len - 1).toString("utf8");
    const eq = body.indexOf("=");
    if (eq <= 0) throw new Error("tar: malformed pax record");
    const key = body.slice(0, eq);
    const value = body.slice(eq + 1);
    if (!PAX_KEYS.has(key)) throw new Error(`tar: pax key ${JSON.stringify(key)} is not allowed`);
    if (seenKeys.has(key)) throw new Error(`tar: duplicate pax key ${key}`);
    seenKeys.add(key);
    if (key === "path") out.path = value;
    else if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) throw new Error(`tar: pax ${key} is not a number`);
    pos += len;
  }
  return out;
}

/**
 * Validates the whole archive before anything is written: header checksums, entry types, paths,
 * duplicates, file/directory conflicts, counts and sizes, trailing data. Returns the entries.
 */
export function validateTar(buf: Uint8Array): TarEntry[] {
  if (buf.length > LIMITS.maxTarBytes) throw new Error(`tar: archive is larger than ${LIMITS.maxTarBytes} bytes`);
  if (buf.length < BLOCK * 2 || buf.length % BLOCK !== 0) throw new Error("tar: not a whole number of 512-byte blocks");
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  const files = new Set<string>();
  const dirs = new Set<string>();
  let total = 0;
  let at = 0;
  let ended = false;
  let pax: { path?: string } | undefined;
  while (at < buf.length) {
    if (isZeroBlock(buf, at)) {
      // End of archive: this and every later block must be zero.
      for (let i = at; i < buf.length; i += BLOCK) if (!isZeroBlock(buf, i)) throw new Error("tar: data after the end-of-archive marker");
      ended = true;
      break;
    }
    if (at + BLOCK > buf.length) throw new Error("tar: truncated header");
    if (!checksumOk(buf, at)) throw new Error("tar: bad header checksum");
    if (!cstr(buf, at + 257, 6).startsWith("ustar")) throw new Error("tar: not a ustar header (pax and GNU formats are rejected)");
    const type = String.fromCharCode(buf[at + 156] === 0 ? 0x30 : buf[at + 156]!);
    if (type === "x") {
      // Extended header for the next entry only; never two in a row, never at the end.
      if (pax) throw new Error("tar: two pax headers in a row");
      const psize = octal(buf, at + 124, 12, "pax size");
      if (psize > LIMITS.maxPaxBytes) throw new Error("tar: pax header too large");
      const pstart = at + BLOCK;
      const ppadded = Math.ceil(psize / BLOCK) * BLOCK;
      if (pstart + ppadded > buf.length) throw new Error("tar: pax data runs past the end of the archive");
      pax = parsePax(buf.subarray(pstart, pstart + psize));
      at = pstart + ppadded;
      continue;
    }
    const name = cstr(buf, at, 100);
    const prefix = cstr(buf, at + 345, 155);
    const full = pax?.path ?? (prefix ? `${prefix}/${name}` : name);
    pax = undefined;
    if (type !== "0" && type !== "5") {
      throw new Error(`tar: entry type ${JSON.stringify(type)} is not allowed (only regular files and directories): ${JSON.stringify(full)}`);
    }
    const size = octal(buf, at + 124, 12, "size");
    const segments = entrySegments(full);
    const normalized = segments.join("/");
    if (type === "5" && size !== 0) throw new Error(`tar: directory with data: ${JSON.stringify(full)}`);
    if (type === "0" && full.endsWith("/")) throw new Error(`tar: file name ends with a slash: ${JSON.stringify(full)}`);
    if (seen.has(normalized)) throw new Error(`tar: duplicate entry: ${JSON.stringify(normalized)}`);
    seen.add(normalized);
    for (let i = 1; i < segments.length; i++) {
      if (files.has(segments.slice(0, i).join("/"))) throw new Error(`tar: entry below a regular file: ${JSON.stringify(normalized)}`);
    }
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join("/"));
    if (type === "5") dirs.add(normalized);
    if (type === "0") {
      if (dirs.has(normalized)) throw new Error(`tar: file also used as a directory: ${JSON.stringify(normalized)}`);
      files.add(normalized);
    }
    if (entries.length + 1 > LIMITS.maxEntries) throw new Error(`tar: more than ${LIMITS.maxEntries} entries`);
    if (size > LIMITS.maxFileBytes) throw new Error(`tar: ${JSON.stringify(normalized)} is larger than ${LIMITS.maxFileBytes} bytes`);
    total += size;
    if (total > LIMITS.maxTotalBytes) throw new Error(`tar: more than ${LIMITS.maxTotalBytes} bytes of content`);
    const dataStart = at + BLOCK;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (dataStart + padded > buf.length) throw new Error("tar: entry data runs past the end of the archive");
    entries.push({ path: normalized, type: type === "5" ? "dir" : "file", offset: dataStart, size });
    at = dataStart + padded;
  }
  if (!ended) throw new Error("tar: missing end-of-archive marker");
  if (pax) throw new Error("tar: pax header without an entry");
  return entries;
}

/** kcw-build.json is read by Terraform and smoke-check: it must be a plain JSON object with these fields. */
export function validateBuildInfo(text: string): { kcw_env: "preview"; build_id: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("kcw-build.json is not JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("kcw-build.json must be a JSON object");
  const { kcw_env, build_id } = raw as { kcw_env?: unknown; build_id?: unknown };
  if (kcw_env !== "preview") throw new Error('kcw-build.json: kcw_env must be "preview"');
  if (typeof build_id !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(build_id)) throw new Error("kcw-build.json: build_id must be a short identifier string");
  return { kcw_env, build_id };
}

/** validateTar plus the kcw-build.json check; returns the entries to extract. */
export function validateWebArchive(buf: Uint8Array): TarEntry[] {
  const entries = validateTar(buf);
  const build = entries.find((e) => e.path === `${OPEN_NEXT_DIR}/kcw-build.json`);
  if (!build || build.type !== "file") throw new Error("tar: .open-next/kcw-build.json is missing");
  validateBuildInfo(Buffer.from(buf.subarray(build.offset, build.offset + build.size)).toString("utf8"));
  return entries;
}

/**
 * Extracts validated entries below `destRoot` (the directory that will contain `.open-next`). This
 * never calls tar and never creates a link, and it refuses to start if `.open-next` already exists,
 * so no pre-existing link can be followed. Files are created exclusively (`wx`).
 */
export function extractEntries(buf: Uint8Array, entries: readonly TarEntry[], destRoot: string): void {
  const root = path.resolve(destRoot);
  const target = path.join(root, OPEN_NEXT_DIR);
  if (existsSync(target) || isLink(target)) throw new Error(`${target} already exists; extract into an empty location`);
  for (const entry of entries) {
    const dest = path.join(root, ...entry.path.split("/"));
    const rel = path.relative(root, dest);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("extract: path escapes the destination");
    if (entry.type === "dir") {
      mkdirSync(dest, { recursive: true, mode: 0o755 });
    } else {
      mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
      writeFileSync(dest, buf.subarray(entry.offset, entry.offset + entry.size), { flag: "wx", mode: 0o644 });
    }
  }
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Removes psql meta-lines and settings a plain pg_dump adds so the dump runs as plain SQL on any server >= 16. */
export function prepareDumpForRestore(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !/^\\(un)?restrict [A-Za-z0-9]+\r?$/.test(line) && !/^SET transaction_timeout = 0;\r?$/.test(line))
    .join("\n");
}
