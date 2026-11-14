import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildManifest,
  checkDbDump,
  DB_FILE,
  entrySegments,
  extractEntries,
  LIMITS,
  parseId,
  parseManifest,
  prepareDumpForRestore,
  sha256Hex,
  validateBuildInfo,
  validateTar,
  validateWebArchive,
  verifyManifest,
  WEB_FILE,
} from "../lib/candidate-artifact";

// ---------- a minimal ustar writer for fixtures ----------

interface Spec {
  name: string;
  type?: string;
  data?: string;
  prefix?: string;
  size?: number;
  magic?: string;
}

function header(spec: Spec): Buffer {
  const h = Buffer.alloc(512);
  h.write(spec.name, 0, "latin1");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  const size = spec.size ?? Buffer.byteLength(spec.data ?? "");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(spec.type ?? "0", 156);
  h.write(spec.magic ?? "ustar\0", 257, "latin1");
  h.write("00", 263);
  if (spec.prefix) h.write(spec.prefix, 345, "latin1");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

function tar(specs: Spec[], opts: { end?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const spec of specs) {
    parts.push(header(spec));
    const data = Buffer.from(spec.data ?? "");
    if (data.length) parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  if (opts.end !== false) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const BUILD = JSON.stringify({ kcw_env: "preview", build_id: "abc123" });
const good = (): Spec[] => [
  { name: ".open-next/", type: "5" },
  { name: ".open-next/kcw-build.json", data: BUILD },
  { name: ".open-next/server-functions/", type: "5" },
  { name: ".open-next/server-functions/index.mjs", data: "export {}" },
];

describe("validateTar", () => {
  it("accepts a normal archive and returns file offsets", () => {
    const buf = tar(good());
    const entries = validateTar(buf);
    expect(entries.map((e) => e.path)).toEqual([
      ".open-next",
      ".open-next/kcw-build.json",
      ".open-next/server-functions",
      ".open-next/server-functions/index.mjs",
    ]);
    const idx = entries[3]!;
    expect(buf.subarray(idx.offset, idx.offset + idx.size).toString()).toBe("export {}");
  });

  it.each([
    ["absolute path", [{ name: "/etc/passwd" }]],
    ["parent segment", [{ name: ".open-next/../x" }]],
    ["dot segment", [{ name: ".open-next/./x" }]],
    ["empty segment", [{ name: ".open-next//x" }]],
    ["outside .open-next", [{ name: "other/file" }]],
    ["sibling prefix", [{ name: ".open-next-evil/file" }]],
    ["backslash", [{ name: ".open-next/a\\b" }]],
    ["drive colon", [{ name: ".open-next/C:x" }]],
    ["symlink", [{ name: ".open-next/l", type: "2" }]],
    ["hardlink", [{ name: ".open-next/l", type: "1" }]],
    ["char device", [{ name: ".open-next/d", type: "3" }]],
    ["block device", [{ name: ".open-next/d", type: "4" }]],
    ["fifo", [{ name: ".open-next/f", type: "6" }]],
    ["pax header", [{ name: ".open-next/p", type: "x", data: "x" }]],
    ["gnu long name", [{ name: "././@LongLink", type: "L", data: "x" }]],
    ["no ustar magic", [{ name: ".open-next/a", magic: "\0\0\0\0\0\0" }]],
    ["directory with data", [{ name: ".open-next/d", type: "5", size: 512 }]],
  ] as [string, Spec[]][])("rejects %s", (_label, specs) => {
    expect(() => validateTar(tar([...specs]))).toThrow();
  });

  it("rejects duplicates, entries below a file and a file that is also a directory", () => {
    expect(() => validateTar(tar([{ name: ".open-next/a", data: "1" }, { name: ".open-next/a", data: "2" }]))).toThrow(/duplicate/);
    expect(() => validateTar(tar([{ name: ".open-next/a", data: "1" }, { name: ".open-next/a/b", data: "2" }]))).toThrow(/below a regular file/);
    expect(() => validateTar(tar([{ name: ".open-next/a/b", data: "2" }, { name: ".open-next/a", data: "1" }]))).toThrow(/also used as a directory/);
  });

  it("uses the ustar prefix field when checking the path", () => {
    expect(() => validateTar(tar([{ name: "x", prefix: "/abs" }]))).toThrow(/absolute/);
    expect(validateTar(tar([{ name: "index.mjs", prefix: ".open-next/deep", data: "1" }]))[0]!.path).toBe(".open-next/deep/index.mjs");
  });

  it("rejects a bad checksum, truncation, a missing end marker and trailing data", () => {
    const buf = tar(good());
    const corrupt = Buffer.from(buf);
    corrupt[10] = corrupt[10]! ^ 1;
    expect(() => validateTar(corrupt)).toThrow(/checksum/);
    expect(() => validateTar(buf.subarray(0, buf.length - 100))).toThrow();
    expect(() => validateTar(tar(good(), { end: false }))).toThrow();
    const trailing = Buffer.concat([buf, Buffer.alloc(512, 1)]);
    expect(() => validateTar(trailing)).toThrow(/after the end/);
    expect(() => validateTar(Buffer.alloc(100))).toThrow();
  });

  it("rejects a declared size that runs past the archive", () => {
    expect(() => validateTar(tar([{ name: ".open-next/a", size: 100000 }]))).toThrow(/past the end/);
  });

  it("enforces the entry count and size limits", () => {
    expect(() => validateTar(tar([{ name: ".open-next/big", size: LIMITS.maxFileBytes + 1 }]))).toThrow(/larger than/);
    const many = Array.from({ length: LIMITS.maxEntries + 1 }, (_, i) => ({ name: `.open-next/d${i}`, type: "5" }));
    expect(() => validateTar(tar(many))).toThrow(/more than 20000 entries/);
  });
});

describe("entrySegments", () => {
  it("returns the segments of a directory name with a trailing slash", () => {
    expect(entrySegments(".open-next/a/")).toEqual([".open-next", "a"]);
  });
  it("rejects control characters and NUL-like names", () => {
    expect(() => entrySegments(".open-next/a\nb")).toThrow();
    expect(() => entrySegments("")).toThrow();
  });
});

describe("kcw-build.json", () => {
  it("accepts the preview build info only", () => {
    expect(validateBuildInfo(BUILD)).toEqual({ kcw_env: "preview", build_id: "abc123" });
    expect(() => validateBuildInfo("not json")).toThrow(/not JSON/);
    expect(() => validateBuildInfo("[]")).toThrow(/object/);
    expect(() => validateBuildInfo(JSON.stringify({ kcw_env: "prod", build_id: "a" }))).toThrow(/preview/);
    expect(() => validateBuildInfo(JSON.stringify({ kcw_env: "preview", build_id: "a b" }))).toThrow(/build_id/);
    expect(() => validateBuildInfo(JSON.stringify({ kcw_env: "preview" }))).toThrow(/build_id/);
  });

  it("validateWebArchive requires it", () => {
    expect(validateWebArchive(tar(good())).length).toBe(4);
    expect(() => validateWebArchive(tar([{ name: ".open-next/a", data: "1" }]))).toThrow(/kcw-build.json is missing/);
    expect(() => validateWebArchive(tar([{ name: ".open-next/kcw-build.json", data: "{" }]))).toThrow(/not JSON/);
  });
});

describe("extractEntries", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(path.join(tmpdir(), "kcw-extract-"));
    dirs.push(d);
    return d;
  };

  it("writes files and directories, never links, below the destination", () => {
    const buf = tar(good());
    const dest = tmp();
    extractEntries(buf, validateWebArchive(buf), dest);
    expect(readFileSync(path.join(dest, ".open-next/server-functions/index.mjs"), "utf8")).toBe("export {}");
    expect(lstatSync(path.join(dest, ".open-next/server-functions")).isDirectory()).toBe(true);
    expect(existsSync(path.join(dest, "..", ".open-next"))).toBe(false);
  });

  it("refuses an existing .open-next", () => {
    const buf = tar(good());
    const dest = tmp();
    extractEntries(buf, validateWebArchive(buf), dest);
    expect(() => extractEntries(buf, validateWebArchive(buf), dest)).toThrow(/already exists/);
  });
});

describe("manifest", () => {
  const sha = "a".repeat(40);
  const db = Buffer.from("-- dump\n");
  const web = tar(good());
  const files = { [DB_FILE]: db, [WEB_FILE]: web };
  const expected = { repositoryId: 7, prNumber: 42, headSha: sha, runId: 99 };
  const manifest = () => buildManifest({ repository_id: 7, pr_number: 42, head_sha: sha, run_id: 99, run_attempt: 1 }, files);

  it("round-trips and verifies", () => {
    const parsed = parseManifest(JSON.stringify(manifest()));
    expect(parsed.files[DB_FILE]).toBe(sha256Hex(db));
    expect(() => verifyManifest(parsed, expected, files)).not.toThrow();
  });

  it.each([
    ["repository", { ...expected, repositoryId: 8 }, /repository_id/],
    ["pr", { ...expected, prNumber: 43 }, /pr_number/],
    ["head", { ...expected, headSha: "b".repeat(40) }, /head_sha/],
    ["run", { ...expected, runId: 100 }, /run_id/],
  ])("rejects a %s mismatch", (_l, exp, re) => {
    expect(() => verifyManifest(manifest(), exp, files)).toThrow(re);
  });

  it("rejects a changed file", () => {
    expect(() => verifyManifest(manifest(), expected, { ...files, [DB_FILE]: Buffer.from("-- other\n") })).toThrow(/preview-db.sql does not match/);
    expect(() => verifyManifest(manifest(), expected, { ...files, [WEB_FILE]: Buffer.concat([web, Buffer.alloc(512)]) })).toThrow(/preview-web.tar does not match/);
  });

  it("rejects malformed manifests", () => {
    const m = manifest();
    expect(() => parseManifest("nope")).toThrow(/not JSON/);
    expect(() => parseManifest("[]")).toThrow(/object/);
    expect(() => parseManifest(JSON.stringify({ ...m, extra: 1 }))).toThrow(/unexpected/);
    expect(() => parseManifest(JSON.stringify({ ...m, schema: 2 }))).toThrow(/schema/);
    expect(() => parseManifest(JSON.stringify({ ...m, head_sha: "XYZ" }))).toThrow(/head_sha/);
    expect(() => parseManifest(JSON.stringify({ ...m, pr_number: "42" }))).toThrow(/pr_number/);
    expect(() => parseManifest(JSON.stringify({ ...m, files: { [DB_FILE]: m.files[DB_FILE] } }))).toThrow(/exactly/);
    expect(() => parseManifest(JSON.stringify({ ...m, files: { ...m.files, [DB_FILE]: "zz" } }))).toThrow(/sha256/);
  });

  it("parses ids strictly", () => {
    expect(parseId("12", "x")).toBe(12);
    expect(() => parseId("0", "x")).toThrow();
    expect(() => parseId("1e3", "x")).toThrow();
    expect(() => parseId(undefined, "x")).toThrow();
  });
});

describe("dump", () => {
  it("accepts text and rejects empty, NUL and non-UTF-8", () => {
    expect(() => checkDbDump(Buffer.from("SELECT 1;\n"))).not.toThrow();
    expect(() => checkDbDump(Buffer.alloc(0))).toThrow(/empty/);
    expect(() => checkDbDump(Buffer.from([0x41, 0]))).toThrow(/NUL/);
    expect(() => checkDbDump(Buffer.from([0xff, 0xfe]))).toThrow(/UTF-8/);
  });

  it("drops only the restrict markers and transaction_timeout from a plain dump", () => {
    const sql = ["\\restrict AbC123", "SET transaction_timeout = 0;", "SET statement_timeout = 0;", "SELECT 1;", "\\! id", "\\unrestrict AbC123", ""].join("\n");
    expect(prepareDumpForRestore(sql)).toBe(["SET statement_timeout = 0;", "SELECT 1;", "\\! id", ""].join("\n"));
  });
});
