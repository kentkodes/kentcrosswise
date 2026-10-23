// Test-only zip writer (PKWARE APPNOTE §4.3), so the reader can be tested on archives with exactly
// the features we want: stored/deflate, data descriptors (as streaming writers such as
// actions/upload-artifact produce), comments, and deliberately broken fields.
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipFileSpec {
  name: string;
  data: Buffer | string;
  method?: 0 | 8;
  /** Write sizes/CRC as zero in the local header and append a data descriptor (flag bit 3). */
  descriptor?: boolean;
  /** Override fields in the central directory (to build broken archives). */
  central?: Partial<{ crc: number; size: number; compressedSize: number; method: number; flags: number }>;
}

export function writeZip(files: ZipFileSpec[], opts: { comment?: string } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const method = f.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data) >>> 0;
    const name = Buffer.from(f.name, "utf8");
    const flags = 0x800 | (f.descriptor ? 0x8 : 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(f.descriptor ? 0 : crc, 14);
    local.writeUInt32LE(f.descriptor ? 0 : body.length, 18);
    local.writeUInt32LE(f.descriptor ? 0 : data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const parts = [local, name, body];
    if (f.descriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(body.length, 8);
      dd.writeUInt32LE(data.length, 12);
      parts.push(dd);
    }
    const localAll = Buffer.concat(parts);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(f.central?.flags ?? flags, 8);
    c.writeUInt16LE(f.central?.method ?? method, 10);
    c.writeUInt32LE(f.central?.crc ?? crc, 16);
    c.writeUInt32LE(f.central?.compressedSize ?? body.length, 20);
    c.writeUInt32LE(f.central?.size ?? data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([c, name]));

    locals.push(localAll);
    offset += localAll.length;
  }
  const cd = Buffer.concat(centrals);
  const comment = Buffer.from(opts.comment ?? "", "utf8");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, eocd, comment]);
}
