// Minimal zip reader for one entry of a GitHub Actions artifact (P2-09 getArtifact). No zip package
// is approved, and an artifact zip needs little: find the entry in the central directory, then
// inflate it with node:zlib. Supports stored (0) and deflate (8) entries, with or without data
// descriptors (sizes come from the central directory). Rejects ZIP64, encryption, multi-disk
// archives, bad offsets and CRC mismatches. Spec: PKWARE APPNOTE.TXT §4.3.
import { crc32, inflateRawSync } from "node:zlib";

export class ZipFormatError extends Error {
  override name = "ZipFormatError";
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;
const FLAG_ENCRYPTED = 0x1;
const FLAG_UTF8 = 0x800;

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

function fail(msg: string): never {
  throw new ZipFormatError(`zip: ${msg}`);
}

function findEocd(buf: Buffer): number {
  if (buf.length < EOCD_SIZE) fail("too short");
  const stop = Math.max(0, buf.length - EOCD_SIZE - MAX_COMMENT);
  for (let i = buf.length - EOCD_SIZE; i >= stop; i--) {
    // The comment length must reach exactly to the end, so a signature inside a comment is skipped.
    if (buf.readUInt32LE(i) === EOCD_SIG && i + EOCD_SIZE + buf.readUInt16LE(i + 20) === buf.length) return i;
  }
  return fail("end of central directory not found");
}

/** Lists the entries of the central directory. */
export function listZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const onDisk = buf.readUInt16LE(eocd + 8);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail("ZIP64 is not supported");
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) fail("multi-disk archives are not supported");
  if (cdOffset + cdSize > eocd) fail("central directory out of bounds");

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + CENTRAL_SIZE > cdOffset + cdSize || buf.readUInt32LE(p) !== CENTRAL_SIG) fail(`bad central directory entry ${n}`);
    const flags = buf.readUInt16LE(p + 8);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const end = p + CENTRAL_SIZE + nameLen + extraLen + commentLen;
    if (end > cdOffset + cdSize) fail(`central directory entry ${n} out of bounds`);
    const entry: ZipEntry = {
      name: buf.toString(flags & FLAG_UTF8 ? "utf8" : "latin1", p + CENTRAL_SIZE, p + CENTRAL_SIZE + nameLen),
      method: buf.readUInt16LE(p + 10),
      flags,
      crc32: buf.readUInt32LE(p + 16),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localHeaderOffset: buf.readUInt32LE(p + 42),
    };
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.localHeaderOffset === 0xffffffff) {
      fail("ZIP64 is not supported");
    }
    entries.push(entry);
    p = end;
  }
  return entries;
}

export interface ReadZipEntryOptions {
  /** Upper bound for the uncompressed size (checked before and during inflation). */
  maxBytes: number;
}

/** Returns the content of the entry named exactly `name`, or undefined if the zip has none. */
export function readZipEntry(buf: Buffer, name: string, opts: ReadZipEntryOptions): Buffer | undefined {
  const matches = listZipEntries(buf).filter((e) => e.name === name);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) fail(`more than one entry named ${name}`);
  const e = matches[0]!;
  if (e.flags & FLAG_ENCRYPTED) fail("encrypted entries are not supported");
  if (e.size > opts.maxBytes) fail(`entry larger than ${opts.maxBytes} bytes`);

  const h = e.localHeaderOffset;
  if (h + LOCAL_SIZE > buf.length || buf.readUInt32LE(h) !== LOCAL_SIG) fail("bad local file header");
  const start = h + LOCAL_SIZE + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  const end = start + e.compressedSize;
  if (end > buf.length) fail("entry data out of bounds");
  const raw = buf.subarray(start, end);

  let out: Buffer;
  if (e.method === 0) {
    if (e.compressedSize !== e.size) fail("stored entry with mismatched sizes");
    out = Buffer.from(raw);
  } else if (e.method === 8) {
    try {
      // maxOutputLength stops a zip bomb even if the declared size lies.
      out = inflateRawSync(raw, { maxOutputLength: Math.max(1, opts.maxBytes) });
    } catch {
      fail("could not inflate entry");
    }
  } else {
    fail(`compression method ${e.method} is not supported`);
  }
  if (out.length !== e.size) fail("entry size mismatch");
  if (crc32(out) >>> 0 !== e.crc32) fail("CRC mismatch");
  return out;
}
