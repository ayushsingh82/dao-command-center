import { createHash, createPublicKey, verify } from "node:crypto";

/**
 * NEAR's off-chain signatures, shared by the DAO signer (a DAO's MPC key signs the hash of an owner intent).
 * Ported from the MultiAgency treasury prototype (`src/nep413.ts`), which signs for a live DAO.
 */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** `length` bytes from base58 text, strictly: leading `1`s are leading zero bytes, and the total must be `length`. */
export function base58(text: string, length: number): Buffer {
  let zeros = 0;
  while (text[zeros] === "1") zeros++;
  let n = 0n;
  for (const c of text) {
    const digit = B58.indexOf(c);
    if (digit < 0) throw new Error("not base58");
    n = n * 58n + BigInt(digit);
  }
  let hex = n === 0n ? "" : n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = Buffer.from(hex, "hex");
  if (zeros + body.length !== length) throw new Error(`not ${length} bytes`);
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

/** Base58 text for bytes. */
export function encodeBase58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** The 32 raw bytes of an `ed25519:<base58>` key. */
export const rawKey = (key: string) => base58(key.replace(/^ed25519:/, ""), 32);

/** Whether `signature` is `key`'s Ed25519 signature over `message`. */
export function verifyEd25519(key: string, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey(key)]);
    return verify(null, message, createPublicKey({ key: spki, format: "der", type: "spki" }), signature);
  } catch {
    return false;
  }
}

/**
 * NEP-413: sha256(borsh(tag 2^31+413) ++ borsh({ message, nonce[32], recipient, callbackUrl })).
 * `callbackUrl` is an Option<String>: some wallets set it to the page that asked, and the signature then
 * covers it.
 */
export function nep413Hash(message: string, nonce: Uint8Array, recipient: string, callbackUrl?: string | null): Buffer {
  if (nonce.length !== 32) throw new Error("a NEP-413 nonce is 32 bytes");
  const str = (s: string) => {
    const bytes = Buffer.from(s, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  const callback = callbackUrl == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), str(callbackUrl)]);
  return createHash("sha256").update(Buffer.concat([tag, str(message), nonce, str(recipient), callback])).digest();
}

/** The implicit NEAR account of an Ed25519 key: its 32 raw bytes in hex. */
export const implicitAccount = (key: string) => rawKey(key).toString("hex");
