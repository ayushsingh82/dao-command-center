import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { base58, encodeBase58, rawKey } from "@/lib/dao/keys";

describe("base58 for keys", () => {
  it("round-trips bytes, including leading zero bytes", () => {
    for (const bytes of [Uint8Array.from([0, 0, 1, 2, 3]), Uint8Array.from([255]), Uint8Array.from({ length: 32 }, (_, i) => i)]) {
      assert.deepEqual(new Uint8Array(base58(encodeBase58(bytes), bytes.length)), bytes);
    }
  });

  it("is strict about the length and the alphabet", () => {
    assert.throws(() => base58("0OIl", 4), /base58/);
    assert.throws(() => base58("11", 4), /bytes/, "two leading ones are two bytes, not four");
    assert.throws(() => base58(encodeBase58(new Uint8Array(31).fill(7)), 32), /bytes/);
    assert.throws(() => rawKey("ed25519:abc"), /bytes/);
  });
});
