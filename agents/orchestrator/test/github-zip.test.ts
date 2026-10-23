import { MERGE_INPUT_FILE, parseMergeInput } from "@kcw/core/merge-input";
import { describe, expect, it } from "vitest";
import { ZipFormatError, listZipEntries, readZipEntry } from "../src/github/zip";
import { writeZip } from "./zip-writer";

const MAX = { maxBytes: 1024 * 1024 };
const json = '{"hello":"world"}\n';

// Written by Python's zipfile (ZIP_DEFLATED), i.e. by an independent implementation; synthetic content.
const PYTHON_ZIP =
  "UEsDBBQAAAAIAES7Vl1DS2NqmAAAACwBAAAWAAAAbWVyZ2UtcnVsZXMtaW5wdXQuanNvbmXPsQrDIBAG4N2nkMwZ2oyd+wYdS4ZDzyAxGoyBluC757SxEbKI9/Er/22M80Y5P0FoHvzepnE2YF/rNIH/km1ElwyBtsoDze/+APBBKxDh/4ZMuNUm6Noio7ZyqSIp5BECkt3aE9dZ/rCrUKLBS9IjFRZZD4ysnDEvZJwYn1qpcxuQEmVdHj96CdoOyUrVeWjytU8fsch2UEsBAhQAFAAAAAgARLtWXUNLY2qYAAAALAEAABYAAAAAAAAAAAAAAIABAAAAAG1lcmdlLXJ1bGVzLWlucHV0Lmpzb25QSwUGAAAAAAEAAQBEAAAAzAAAAAAA";

describe("readZipEntry", () => {
  it("reads a zip written by another implementation (Python zipfile)", () => {
    const out = readZipEntry(Buffer.from(PYTHON_ZIP, "base64"), MERGE_INPUT_FILE, MAX);
    expect(out).toBeDefined();
    expect(parseMergeInput(out!.toString("utf8")).lockDiff.existing).toEqual(["pg"]);
  });

  it("reads deflated and stored entries", () => {
    expect(readZipEntry(writeZip([{ name: "a.json", data: json }]), "a.json", MAX)?.toString()).toBe(json);
    expect(readZipEntry(writeZip([{ name: "a.json", data: json, method: 0 }]), "a.json", MAX)?.toString()).toBe(json);
  });

  it("uses central directory sizes when the local header defers them to a data descriptor", () => {
    const zip = writeZip([
      { name: "other.txt", data: "x".repeat(500), descriptor: true },
      { name: "a.json", data: json, descriptor: true },
    ]);
    expect(readZipEntry(zip, "a.json", MAX)?.toString()).toBe(json);
  });

  it("finds the end record behind an archive comment, even one containing its signature", () => {
    const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]).toString("latin1");
    const zip = writeZip([{ name: "a.json", data: json }], { comment: `note ${sig} more` });
    expect(readZipEntry(zip, "a.json", MAX)?.toString()).toBe(json);
  });

  it("lists entries and returns undefined for a missing name (exact match only)", () => {
    const zip = writeZip([{ name: "dir/a.json", data: json }, { name: "b.json", data: "{}" }]);
    expect(listZipEntries(zip).map((e) => e.name)).toEqual(["dir/a.json", "b.json"]);
    expect(readZipEntry(zip, "a.json", MAX)).toBeUndefined();
  });

  it("reads an empty archive", () => {
    expect(listZipEntries(writeZip([]))).toEqual([]);
  });

  it.each([
    ["not a zip", Buffer.from("definitely not a zip file, but long enough")],
    ["too short", Buffer.alloc(10)],
    ["truncated", writeZip([{ name: "a.json", data: json }]).subarray(5)],
  ])("rejects %s", (_label, buf) => {
    expect(() => readZipEntry(buf, "a.json", MAX)).toThrow(ZipFormatError);
  });

  it.each([
    ["a CRC mismatch", { crc: 1 }, /CRC/],
    ["a wrong uncompressed size", { size: json.length + 1 }, /size mismatch/],
    ["ZIP64 size markers", { size: 0xffffffff }, /ZIP64/],
    ["an encrypted entry", { flags: 0x801 }, /encrypted/],
    ["an unsupported method", { method: 12 }, /method 12/],
    ["data past the end", { compressedSize: 100000 }, /out of bounds/],
  ])("rejects %s", (_label, central, msg) => {
    const zip = writeZip([{ name: "a.json", data: json, central }]);
    expect(() => readZipEntry(zip, "a.json", MAX)).toThrow(msg);
  });

  it("enforces maxBytes on the declared size and on the inflated output", () => {
    const big = "a".repeat(10_000);
    expect(() => readZipEntry(writeZip([{ name: "a", data: big }]), "a", { maxBytes: 1000 })).toThrow(/larger than/);
    // Declared tiny, inflates to 10 KB: inflation stops at maxBytes.
    const bomb = writeZip([{ name: "a", data: big, central: { size: 10 } }]);
    expect(() => readZipEntry(bomb, "a", { maxBytes: 1000 })).toThrow(/inflate/);
  });

  it("rejects duplicate entry names", () => {
    const zip = writeZip([{ name: "a.json", data: json }, { name: "a.json", data: "{}" }]);
    expect(() => readZipEntry(zip, "a.json", MAX)).toThrow(/more than one/);
  });
});
