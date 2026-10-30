import { Near } from "near-kit";
import { verifyEd25519 } from "@/lib/dao/keys";
import type { NearOwner, SignatureFinder } from "@/lib/dao/signer";
import type { FunctionCallAction, NearReader, NearSender, SentTransaction, ViewOptions } from "@/lib/dao/types";

type Fetch = typeof fetch;

export type RpcOptions = {
  rpcUrl: string;
  /** Sent on every request, for a keyed RPC (for example an `Authorization` header). Never logged. */
  headers?: Record<string, string>;
  fetch?: Fetch;
  timeoutMs?: number;
};

/** The chain says there is nothing there to ask: no such account, no contract on it, or no such method. */
const MISSING = /UNKNOWN_ACCOUNT|NO_CONTRACT_CODE|does not exist|CodeDoesNotExist|MethodNotFound|MethodResolveError/i;

/** NEAR JSON-RPC reads over plain `fetch`. */
export function rpcReader(o: RpcOptions): NearReader {
  const doFetch = o.fetch ?? fetch;
  let id = 0;
  async function rpc(method: string, params: unknown): Promise<{ result?: any; error?: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    let res: Response;
    try {
      res = await doFetch(o.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...o.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
      });
    } catch (e) {
      throw new Error(`NEAR RPC unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new Error(`NEAR RPC answered ${res.status}`);
    return (await res.json()) as { result?: unknown; error?: unknown };
  }
  const describe = (e: unknown) => (typeof e === "string" ? e : JSON.stringify(e));

  return {
    async view<T>(contractId: string, method: string, args: object = {}, opts: ViewOptions = {}): Promise<T | null> {
      const body = await rpc("query", {
        request_type: "call_function",
        finality: opts.finality ?? "final",
        account_id: contractId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      });
      const failure = body.error ?? body.result?.error;
      if (failure) {
        const text = describe(failure);
        if (MISSING.test(text) && !/Smart contract panicked|ERR_/.test(text)) return null;
        throw new Error(`view ${contractId}.${method} failed: ${text}`);
      }
      const bytes: number[] = body.result?.result ?? [];
      if (!bytes.length) return null;
      return JSON.parse(Buffer.from(bytes).toString()) as T;
    },
    async blockHeight() {
      const body = await rpc("status", []);
      if (body.error) throw new Error(`status failed: ${describe(body.error)}`);
      return Number(body.result.sync_info.latest_block_height);
    },
    async accountExists(accountId: string) {
      const body = await rpc("query", { request_type: "view_account", finality: "final", account_id: accountId });
      const failure = body.error ?? body.result?.error;
      if (failure) {
        if (MISSING.test(describe(failure))) return false;
        throw new Error(`view_account failed: ${describe(failure)}`);
      }
      return true;
    },
  };
}

export type SenderOptions = {
  rpcUrl: string;
  networkId: string;
  accountId: string;
  /** `ed25519:…`. Held in this object only; never logged. */
  privateKey: `ed25519:${string}`;
  headers?: Record<string, string>;
};

/** Signs and sends as one account with near-kit, waiting until every receipt has executed. */
export function nearKitSender(o: SenderOptions): NearSender {
  const near = new Near({ network: { rpcUrl: o.rpcUrl, networkId: o.networkId }, privateKey: o.privateKey, defaultSignerId: o.accountId, headers: o.headers });
  return {
    accountId: o.accountId,
    async send(receiverId: string, actions: FunctionCallAction[]): Promise<SentTransaction> {
      const tx = actions.reduce(
        (t, a) => t.functionCall(receiverId, a.methodName, a.args, { gas: a.gas as never, attachedDeposit: BigInt(a.deposit) }),
        near.transaction(o.accountId),
      );
      const outcome = (await tx.send({ waitUntil: "EXECUTED" })) as unknown as {
        status?: { SuccessValue?: string; Failure?: unknown };
        transaction?: { hash?: string };
      };
      if (outcome.status?.Failure) throw new Error(`transaction failed: ${JSON.stringify(outcome.status.Failure)}`);
      const value = outcome.status?.SuccessValue;
      let returnValue: unknown = null;
      if (value) {
        try {
          returnValue = JSON.parse(Buffer.from(value, "base64").toString());
        } catch {
          returnValue = Buffer.from(value, "base64").toString();
        }
      }
      return { hash: outcome.transaction?.hash ?? "", returnValue };
    },
  };
}

type Transactions = { transactions?: { receipts?: { execution_outcome?: { outcome?: { status?: { SuccessValue?: string } } } }[] }[] };

export type FastNearOptions = {
  /** Default FastNear's mainnet transactions API. */
  baseUrl?: string;
  /** Sent as a bearer token. Never logged. */
  apiKey?: string;
  fetch?: Fetch;
};

/**
 * Finds a DAO's `v1.signer` signature through FastNear's Transactions API: the DAO's own outgoing calls since
 * the request was prepared, with their receipts. Read again on every call, because `v1.signer` answers in a
 * later receipt than the transaction that caused it. Only a signature that verifies against the owner key counts.
 */
export function fastNearSignatureFinder(o: FastNearOptions = {}): SignatureFinder {
  const doFetch = o.fetch ?? fetch;
  const base = (o.baseUrl ?? "https://tx.main.fastnear.com/v0").replace(/\/$/, "");
  async function post<T>(path: string, body: object): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // Do not forward transport messages: they can carry request details.
      throw new Error("FastNear read unavailable. Check connectivity and try again.");
    }
    if (res.status === 401 || res.status === 403) throw new Error("FastNear authentication failed. Check the API key.");
    if (res.status === 429) throw new Error("FastNear rate limit reached.");
    if (!res.ok) throw new Error(`FastNear read unavailable (HTTP ${res.status}).`);
    return (await res.json()) as T;
  }

  return {
    async find({ dao, owner, hash, since }: { dao: string; owner: NearOwner; hash: string; since: number }) {
      const candidates: string[] = [];
      let resume: string | undefined;
      do {
        const page = await post<{ account_txs?: { transaction_hash: string }[]; resume_token?: string }>("/account", {
          account_id: dao, is_predecessor: true, from_tx_block_height: since, desc: true, limit: 200, resume_token: resume,
        });
        const txs = page.account_txs ?? [];
        candidates.push(...txs.map((t) => t.transaction_hash));
        resume = txs.length > 0 ? page.resume_token : undefined;
      } while (resume);

      // 20 is the most /transactions accepts in one call.
      for (let i = 0; i < candidates.length; i += 20) {
        const { transactions = [] } = await post<Transactions>("/transactions", { tx_hashes: candidates.slice(i, i + 20) });
        for (const receipt of transactions.flatMap((t) => t.receipts ?? [])) {
          const value = receipt.execution_outcome?.outcome?.status?.SuccessValue;
          if (!value) continue;
          try {
            const result = JSON.parse(Buffer.from(value, "base64").toString());
            if (result?.scheme !== "Ed25519" || !Array.isArray(result.signature)) continue;
            const signature = Uint8Array.from(result.signature);
            if (verifyEd25519(owner.public_key, Buffer.from(hash, "hex"), signature)) return signature;
          } catch {
            // not a signature receipt
          }
        }
      }
      return null;
    },
  };
}
