import type { GenerateIntentResponse, Intent, OwnerWallet, SignedData } from "@near-intents-agent-api/sdk";
import { AgentApiError } from "@/lib/errors";
import type { OwnerSigner } from "@/lib/agent-api/live";
import type { DelegateBuilder } from "@/lib/dao/delegate";
import { implicitAccount, nep413Hash, verifyEd25519 } from "@/lib/dao/keys";
import type { SputnikDao } from "@/lib/dao/sputnik";
import type { FunctionCallKind, NearReader, NearSender } from "@/lib/dao/types";

/**
 * A DAO as an agent's owner. A Sputnik DAO holds no keys, but it can sign through NEAR's MPC network: a proposal
 * calling `v1.signer.sign` produces an Ed25519 signature for a key derived from the DAO and a path, and only the
 * DAO can ask for it. The owner is the implicit account of that key, so to the Agent API it is an ordinary NEAR
 * owner, and each owner signature is a DAO vote. This follows the MultiAgency treasury prototype, which does it
 * on mainnet.
 */

export const MPC_SIGNER = "v1.signer";
/** The key path for agents' owner signatures. A different path is a different key. */
export const OWNER_PATH = "agent-owner";
export const DOMAIN_ID = 1;

export type NearOwner = Extract<OwnerWallet, { type: "near" }>;
type Nep413Payload = Extract<Intent, { standard: "nep413" }>["payload"] & { callbackUrl?: string | null };

/** The DAO's owner account: the implicit account of its MPC key on the owner path. */
export async function daoOwner(reader: NearReader, dao: string, signerContract = MPC_SIGNER): Promise<NearOwner> {
  const publicKey = await reader.view<string>(signerContract, "derived_public_key", { path: OWNER_PATH, predecessor: dao, domain_id: DOMAIN_ID });
  if (!publicKey || !publicKey.startsWith("ed25519:")) throw new AgentApiError("owner_key_unavailable", `${signerContract} derived no Ed25519 key for ${dao}`, 502);
  return { type: "near", account_id: implicitAccount(publicKey), public_key: publicKey };
}

/** The proposal kind that asks `v1.signer` to sign `hash` with the owner's key. */
export function signProposalKind(hash: string, signerContract = MPC_SIGNER): FunctionCallKind {
  const args = { request: { path: OWNER_PATH, payload_v2: { Eddsa: hash }, domain_id: DOMAIN_ID } };
  return {
    FunctionCall: {
      receiver_id: signerContract,
      actions: [{ method_name: "sign", args: Buffer.from(JSON.stringify(args)).toString("base64"), deposit: "1", gas: "50000000000000" }],
    },
  };
}

/** The hash inside a proposal that asks `v1.signer` to sign with the owner path, if it is one. */
export function signedHashOf(kind: unknown, signerContract = MPC_SIGNER): string | null {
  const call = (kind as { FunctionCall?: FunctionCallKind["FunctionCall"] } | null)?.FunctionCall;
  if (!call || call.receiver_id !== signerContract || call.actions.length !== 1 || call.actions[0]!.method_name !== "sign") return null;
  try {
    const { request } = JSON.parse(Buffer.from(call.actions[0]!.args, "base64").toString()) as { request: { path: string; payload_v2?: { Eddsa?: string }; domain_id: number } };
    if (request.path !== OWNER_PATH || request.domain_id !== DOMAIN_ID) return null;
    return request.payload_v2?.Eddsa?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** What the DAO signs for one owner intent, as plain data. */
export type SigningRequest = {
  owner: NearOwner;
  intent: Intent;
  /** Hex of the 32 bytes the DAO's key signs. */
  hash: string;
  /** For a delegate action, its exact bytes (base64). The DAO's signature goes in their last 64 bytes. */
  delegate?: string;
  /** The block height when it was prepared: no proposal can have signed it before. */
  since: number;
};

export type PrepareDeps = { reader: NearReader; delegate: DelegateBuilder };

export async function signingRequest(intent: Intent, owner: NearOwner, deps: PrepareDeps): Promise<SigningRequest> {
  const since = await deps.reader.blockHeight();
  if (intent.standard === "nep413") {
    const { message, nonce, recipient, callbackUrl } = intent.payload as Nep413Payload;
    return { owner, intent, since, hash: nep413Hash(message, Buffer.from(nonce, "base64"), recipient, callbackUrl).toString("hex") };
  }
  if (intent.standard === "nep366") {
    // A delegate action needs the owner's access key on chain, which exists once the account is funded.
    if (!(await deps.reader.accountExists(owner.account_id))) {
      throw new AgentApiError("owner_account_unfunded", `send NEAR to the DAO's owner account ${owner.account_id} first: a delegate action needs its access key on chain`, 409);
    }
    const { hash, bytes } = await deps.delegate(intent.payload, owner);
    return { owner, intent, since, hash: Buffer.from(hash).toString("hex"), delegate: Buffer.from(bytes).toString("base64") };
  }
  throw new AgentApiError("owner_standard_unsupported", `a DAO owner signs NEAR intents only, not ${intent.standard}`, 400);
}

/** The signed data that the DAO's signature completes. */
export function completeSigning({ owner, intent, delegate }: SigningRequest, signature: Uint8Array): SignedData {
  if (!delegate) return { ...intent, public_key: owner.public_key, signature: Buffer.from(signature).toString("base64") } as unknown as SignedData;
  const signed = Buffer.from(delegate, "base64");
  Buffer.from(signature).copy(signed, signed.length - 64);
  return { ...intent, signed_delegate: signed.toString("base64") } as unknown as SignedData;
}

/** Finds the signature `v1.signer` returned once a proposal asking for it has passed. */
export interface SignatureFinder {
  /** The 64-byte signature over `hash`, or null while there is none yet. Only a signature that verifies counts. */
  find(a: { dao: string; owner: NearOwner; hash: string; since: number }): Promise<Uint8Array | null>;
}

export type SigningProgress = {
  type: string;
  agentId: string;
  correlationId: string;
  hash: string;
  proposalId: number;
  dao: string;
  /** When the request stops being usable: the API's window, or the signer's own limit. */
  expiresAt: string;
  state: "waiting" | "signed" | "refused" | "expired";
};

export type DaoOwnerSignerOptions = {
  dao: SputnikDao;
  /** Files the proposal (and, with `oneClick`, approves it). Must be allowed to add `call` proposals. */
  sender: NearSender;
  reader: NearReader;
  finder: SignatureFinder;
  owner: NearOwner;
  delegate: DelegateBuilder;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** How often to look for the signature. Default 2 seconds. */
  pollMs?: number;
  /** The MPC signer contract. `v1.signer` on mainnet; a stand-in in tests. */
  signerContract?: string;
  /** The longest to wait, whatever the API allows. Default 5 minutes, which is how long the API has been seen to allow. */
  maxWaitMs?: number;
  /** File and approve in one transaction. With a one-vote threshold the DAO signs at once. */
  oneClick?: boolean;
  /** Told when a request is waiting for votes, so a screen can show members what to approve. */
  onProgress?: (p: SigningProgress) => void;
};

const REFUSED = new Set(["Rejected", "Removed", "Expired", "Moved", "Failed"]);

/**
 * The owner signer for a DAO owner. `sign` prepares the hash, files a proposal asking `v1.signer` to sign it,
 * waits for the council to approve, finds the signature on chain, checks it against the owner key, and returns
 * the signed intent. It gives up when the API's signing window closes: a signature after that cannot be used.
 */
export class DaoOwnerSigner implements OwnerSigner {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Requests being waited on, by hash. */
  readonly pending = new Map<string, SigningProgress>();

  constructor(private readonly o: DaoOwnerSignerOptions) {
    this.now = o.now ?? (() => new Date());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async sign(generated: GenerateIntentResponse): Promise<SignedData> {
    const o = this.o;
    const request = await signingRequest(generated.intent, o.owner, { reader: o.reader, delegate: o.delegate });
    const deadline = Math.min(Date.parse(generated.expires_at) || Infinity, this.now().getTime() + (o.maxWaitMs ?? 300_000));
    const progress: SigningProgress = {
      type: generated.type, agentId: generated.agent_id, correlationId: generated.correlation_id, hash: request.hash,
      proposalId: -1, dao: o.dao.accountId, expiresAt: new Date(deadline).toISOString(), state: "waiting",
    };

    // Asked before (a retry after a crash)? Use the proposal already open for this exact hash.
    const existing = (await o.dao.recent(50)).find((p) => p.status === "InProgress" && signedHashOf(p.kind, o.signerContract) === request.hash);
    progress.proposalId = existing
      ? existing.id
      : await this.file(request.hash, `Sign owner action "${generated.type}" for agent ${generated.agent_id}\nrequest ${generated.correlation_id}\nhash ${request.hash}`);
    this.pending.set(request.hash, progress);
    o.onProgress?.({ ...progress });

    try {
      for (;;) {
        const signature = await o.finder.find({ dao: o.dao.accountId, owner: o.owner, hash: request.hash, since: request.since });
        if (signature && verifyEd25519(o.owner.public_key, Buffer.from(request.hash, "hex"), signature)) {
          this.finish(progress, "signed");
          return completeSigning(request, signature);
        }
        const proposal = await o.dao.proposal(progress.proposalId);
        if (proposal && REFUSED.has(proposal.status)) {
          this.finish(progress, "refused");
          throw new AgentApiError("owner_signature_refused", `the DAO's proposal ${progress.proposalId} to sign ${generated.type} ended ${proposal.status}`, 409);
        }
        if (this.now().getTime() >= deadline) {
          this.finish(progress, "expired");
          throw new AgentApiError(
            "owner_signature_expired",
            `the DAO did not sign ${generated.type} in time (proposal ${progress.proposalId}). Members must approve within the API's signing window; ask again`,
            408,
          );
        }
        await this.sleep(o.pollMs ?? 2_000);
      }
    } finally {
      this.pending.delete(request.hash);
    }
  }

  private async file(hash: string, description: string): Promise<number> {
    const kind = signProposalKind(hash, this.o.signerContract);
    return this.o.oneClick ? this.o.dao.fileAndApprove(this.o.sender, description, kind) : this.o.dao.file(this.o.sender, description, kind);
  }

  private finish(p: SigningProgress, state: SigningProgress["state"]) {
    p.state = state;
    this.o.onProgress?.({ ...p });
  }
}
