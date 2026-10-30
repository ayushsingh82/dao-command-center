import type { Intent } from "@near-intents-agent-api/sdk";
import { Near, encodeSignedDelegateAction, parsePublicKey } from "near-kit";
import type { NearOwner } from "@/lib/dao/signer";

export type Nep366Payload = Extract<Intent, { standard: "nep366" }>["payload"];

/** What the DAO must sign for a delegate action: its hash, and the exact bytes the signature will complete. */
export type Delegate = { hash: Uint8Array; bytes: Uint8Array };

export type DelegateBuilder = (payload: Nep366Payload, owner: NearOwner) => Promise<Delegate>;

export type DelegateBuilderOptions = {
  rpcUrl: string;
  networkId: string;
  headers?: Record<string, string>;
  /** Blocks the delegate action stays valid. Default 6000, about an hour and three quarters. The Agent API's own expiry is the tighter limit. */
  blockHeightOffset?: number;
};

/**
 * NEP-366: the delegate action near-kit builds for `payload` as the owner account, signed by a key store whose one
 * key is the owner's. That key's signer only records the hash it is asked to sign and returns a placeholder; the
 * DAO's MPC signature over that hash later replaces the placeholder's last 64 bytes (see `completeSigning`).
 * The bytes hold a nonce and a block height read from chain, so building them again would give another hash than
 * the one the DAO voted on: keep them with the request.
 */
export function nearKitDelegateBuilder(o: DelegateBuilderOptions): DelegateBuilder {
  return async (payload, owner) => {
    let hash: Uint8Array | undefined;
    const key = {
      publicKey: parsePublicKey(owner.public_key),
      secretKey: "",
      sign: (message: Uint8Array) => {
        hash = message;
        return { keyType: 0 as never, data: new Uint8Array(64) };
      },
    };
    const keyStore = { get: async () => key, add: async () => {}, remove: async () => {}, list: async () => [owner.account_id] };
    const near = new Near({ network: { rpcUrl: o.rpcUrl, networkId: o.networkId }, headers: o.headers, keyStore } as never);
    const tx = payload.actions.reduce(
      (t, { params }) => t.functionCall(payload.receiverId, params.methodName, params.args, { gas: params.gas as never, attachedDeposit: BigInt(params.deposit) }),
      near.transaction(owner.account_id),
    );
    const { signedDelegateAction } = await tx.delegate({ blockHeightOffset: o.blockHeightOffset ?? 6000 });
    if (!hash) throw new Error("the delegate action was built without being signed");
    return { hash, bytes: encodeSignedDelegateAction(signedDelegateAction, "bytes") as Uint8Array };
  };
}
