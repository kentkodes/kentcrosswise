// RFC 8291 (Web Push message encryption) with the RFC 8188 aes128gcm content coding, node:crypto only.
// One record per message: the push payloads here are a few hundred bytes at most.
import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

export const MAX_PLAINTEXT_BYTES = 3993; // 4096 record size - 16 tag - 1 delimiter - 86 header

const RECORD_SIZE = 4096;

export interface EncryptInput {
  plaintext: Uint8Array;
  /** The subscription's p256dh key: 65-byte uncompressed P-256 point. */
  uaPublic: Uint8Array;
  /** The subscription's auth key: 16 random bytes. */
  authSecret: Uint8Array;
  /** Randomness, injected by tests. Defaults: 16 random bytes and a fresh P-256 key pair. */
  salt?: Uint8Array;
  senderPrivate?: Uint8Array;
}

const b = (...parts: (Uint8Array | string)[]) => Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : p)));
const hkdf = (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) =>
  Buffer.from(hkdfSync("sha256", ikm, salt, info, len));

/** Returns the request body: the 86-byte header (salt, record size, key id = sender public key) then the ciphertext. */
export function encryptPayload(input: EncryptInput): Buffer {
  const { plaintext, uaPublic, authSecret } = input;
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new RangeError("bad_ua_public");
  if (authSecret.length !== 16) throw new RangeError("bad_auth_secret");
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new RangeError("payload_too_large");
  const salt = Buffer.from(input.salt ?? randomBytes(16));
  if (salt.length !== 16) throw new RangeError("bad_salt");

  const ecdh = createECDH("prime256v1");
  if (input.senderPrivate) ecdh.setPrivateKey(Buffer.from(input.senderPrivate));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(Buffer.from(uaPublic));

  const ikm = hkdf(authSecret, secret, b("WebPush: info\0", uaPublic, asPublic), 32);
  const cek = hkdf(salt, ikm, b("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, b("Content-Encoding: nonce\0"), 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(b(plaintext, Buffer.from([2]))), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return b(salt, rs, Buffer.from([asPublic.length]), asPublic, body);
}
