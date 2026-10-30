import { ed25519 } from "@noble/curves/ed25519.js";
import type { SignatureFinder, NearOwner } from "@/lib/dao/signer";
import { MPC_SIGNER, OWNER_PATH } from "@/lib/dao/signer";
import { encodeBase58, implicitAccount, verifyEd25519 } from "@/lib/dao/keys";
import type { FakeDao } from "@/lib/testing/fake-dao";

/**
 * A stand-in for NEAR's MPC signer. It holds one Ed25519 key for the DAO's owner path and signs what a passed
 * proposal asks it to, the way `v1.signer` does: an Ed25519 signature over the requested hash, returned as JSON.
 */
export function installFakeMpc(chain: FakeDao, secretKey: Uint8Array = ed25519.utils.randomSecretKey()) {
  const publicKey = `ed25519:${encodeBase58(ed25519.getPublicKey(secretKey))}`;
  const owner: NearOwner = { type: "near", account_id: implicitAccount(publicKey), public_key: publicKey };
  chain.handlers.set(`${MPC_SIGNER}.derived_public_key`, ({ args }) => {
    if (args.path !== OWNER_PATH || args.predecessor !== chain.dao) return null;
    return publicKey;
  });
  chain.handlers.set(`${MPC_SIGNER}.sign`, ({ args }) => {
    const request = args.request as { path: string; payload_v2: { Eddsa: string } };
    if (request.path !== OWNER_PATH) throw new Error("not this DAO's path");
    return { scheme: "Ed25519", signature: [...ed25519.sign(Buffer.from(request.payload_v2.Eddsa, "hex"), secretKey)] };
  });
  chain.existing.add(owner.account_id);
  return { owner, secretKey, publicKey };
}

/** Looks for the signature in what passed proposals did on the fake chain, as the FastNear finder does on the real one. */
export class FakeFinder implements SignatureFinder {
  calls = 0;
  constructor(private chain: FakeDao) {}
  async find({ owner, hash, since }: { dao: string; owner: NearOwner; hash: string; since: number }) {
    this.calls++;
    for (const e of this.chain.executions) {
      if (e.atBlock < since) continue;
      const r = e.result as { scheme?: string; signature?: number[] } | null;
      if (r?.scheme !== "Ed25519" || !Array.isArray(r.signature)) continue;
      const signature = Uint8Array.from(r.signature);
      if (verifyEd25519(owner.public_key, Buffer.from(hash, "hex"), signature)) return signature;
    }
    return null;
  }
}
