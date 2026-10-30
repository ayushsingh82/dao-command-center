import { LiveAgentApi } from "@/lib/agent-api/live";
import { CommandCenter } from "@/lib/command-center/service";
import { nearKitDelegateBuilder, type DelegateBuilder } from "@/lib/dao/delegate";
import { DaoFunder } from "@/lib/dao/funder";
import { SputnikGovernance } from "@/lib/dao/governance";
import { FileLedger } from "@/lib/dao/ledger";
import { fastNearSignatureFinder, nearKitSender, rpcReader } from "@/lib/dao/live";
import { DaoOwnerSigner, MPC_SIGNER, daoOwner, type SignatureFinder } from "@/lib/dao/signer";
import { SputnikDao } from "@/lib/dao/sputnik";
import type { NearReader, NearSender } from "@/lib/dao/types";
import { FileRepository } from "@/lib/persistence/repository";

export class LiveConfigProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveConfigProblem";
  }
}

export type LiveCenterConfig = {
  rpcUrl: string;
  networkId: string;
  dao: string;
  /** A DAO member who may file `vote` and `call` proposals (and, for one-click, approve them). It pays the proposal bond. */
  proposerId: string;
  /** Held in memory only. Never logged. */
  proposerKey: `ed25519:${string}`;
  agentApiKey: string;
  agentApiBaseUrl?: string;
  /** The DAO's stable token, whose balance is the treasury the sleeves are funded from. */
  stableToken: string;
  mpcSigner: string;
  fastNearKey?: string;
  /** Tells apart command centers that share one DAO. */
  scope: string;
  /** File and approve in one transaction. Passes at once only if the DAO's threshold is one. */
  oneClick: boolean;
  stateFile: string;
  ledgerFile: string;
};

const ACCOUNT = /^[a-z0-9._-]{2,64}$/;

/**
 * Read the live settings from the environment. Every problem is reported at once, and no value is echoed: a secret
 * in the wrong place must not end up in a log. Spending real money needs an explicit `CONFIRM_REAL_FUNDS=yes`.
 */
export function loadLiveCenterConfig(env: Record<string, string | undefined>): LiveCenterConfig {
  const problems: string[] = [];
  const need = (name: string) => {
    const v = env[name]?.trim();
    if (!v) problems.push(`${name} is required`);
    return v ?? "";
  };
  const account = (name: string) => {
    const v = need(name);
    if (v && !ACCOUNT.test(v)) problems.push(`${name} is not a NEAR account id`);
    return v;
  };

  if (env.CONFIRM_REAL_FUNDS !== "yes") problems.push("CONFIRM_REAL_FUNDS=yes is required: the Agent API has no test network, so a live run spends real funds");
  const rpcUrl = need("NEAR_RPC_URL");
  if (rpcUrl && !/^https?:\/\//.test(rpcUrl)) problems.push("NEAR_RPC_URL must start with http:// or https://");
  const dao = account("DAO_ACCOUNT_ID");
  const proposerId = account("PROPOSER_ACCOUNT_ID");
  const proposerKey = need("PROPOSER_PRIVATE_KEY");
  if (proposerKey && !/^ed25519:/.test(proposerKey)) problems.push("PROPOSER_PRIVATE_KEY must look like ed25519:… (the value is not shown)");
  const agentApiKey = need("NEAR_INTENTS_AGENT_API_KEY");
  if (agentApiKey && !agentApiKey.startsWith("naa_")) problems.push("NEAR_INTENTS_AGENT_API_KEY must start with naa_ (the value is not shown)");
  const stableToken = need("STABLE_TOKEN_ID");
  const agentApiBaseUrl = env.AGENT_API_BASE_URL?.trim() || undefined;
  if (agentApiBaseUrl && !/^https:\/\//.test(agentApiBaseUrl)) problems.push("AGENT_API_BASE_URL must start with https://");

  if (problems.length) throw new LiveConfigProblem(`live mode is not configured: ${problems.join("; ")}`);
  return {
    rpcUrl,
    networkId: env.NEAR_NETWORK_ID?.trim() || "mainnet",
    dao,
    proposerId,
    proposerKey: proposerKey as LiveCenterConfig["proposerKey"],
    agentApiKey,
    agentApiBaseUrl,
    stableToken,
    mpcSigner: env.MPC_SIGNER_ID?.trim() || MPC_SIGNER,
    fastNearKey: env.FASTNEAR_API_KEY?.trim() || undefined,
    scope: env.COMMAND_CENTER_SCOPE?.trim() || "main",
    oneClick: env.ONE_CLICK === "yes",
    stateFile: env.STATE_FILE?.trim() || ".data/state.json",
    ledgerFile: env.LEDGER_FILE?.trim() || ".data/ledger.json",
  };
}

/** Pieces a test can replace so the whole assembly runs without a network. */
export type LiveOverrides = {
  reader?: NearReader;
  proposer?: NearSender;
  finder?: SignatureFinder;
  delegate?: DelegateBuilder;
  agentApiFetch?: typeof fetch;
  now?: () => Date;
};

/**
 * The command center on a real DAO and the real Agent API. Councils vote from their own wallets (Trezu); the DAO
 * signs owner intents through its MPC key; the DAO's treasury funds the sleeves. It spends real money.
 *
 * Every owner action costs the council votes (see docs/dao-live.md), and the Agent API gives each signature
 * request only a few minutes, so a council has to be ready when an action starts.
 */
export async function createLiveCommandCenter(c: LiveCenterConfig, o: LiveOverrides = {}): Promise<CommandCenter> {
  const headers = c.fastNearKey && /fastnear/.test(c.rpcUrl) ? { Authorization: `Bearer ${c.fastNearKey}` } : undefined;
  const reader = o.reader ?? rpcReader({ rpcUrl: c.rpcUrl, headers });
  const proposer = o.proposer ?? nearKitSender({ rpcUrl: c.rpcUrl, networkId: c.networkId, accountId: c.proposerId, privateKey: c.proposerKey, headers });
  const dao = new SputnikDao(c.dao, reader);

  const governance = await SputnikGovernance.connect({ dao, proposer, ledger: new FileLedger(c.ledgerFile), scope: c.scope, approveOnFiling: c.oneClick, now: o.now });
  const owner = await daoOwner(reader, c.dao, c.mpcSigner);
  const signer = new DaoOwnerSigner({
    dao, sender: proposer, reader, owner, oneClick: c.oneClick, signerContract: c.mpcSigner, now: o.now,
    finder: o.finder ?? fastNearSignatureFinder({ apiKey: c.fastNearKey }),
    delegate: o.delegate ?? nearKitDelegateBuilder({ rpcUrl: c.rpcUrl, networkId: c.networkId, headers }),
  });
  const funder = new DaoFunder({ dao, sender: proposer, oneClick: c.oneClick, now: o.now });
  const api = await LiveAgentApi.connect({ apiKey: c.agentApiKey, realFunds: true, owner, signer, funder, baseUrl: c.agentApiBaseUrl, fetch: o.agentApiFetch });

  const treasury = BigInt((await reader.view<string>(c.stableToken, "ft_balance_of", { account_id: c.dao })) ?? "0");
  const center = new CommandCenter({ api, governance, now: o.now ?? (() => new Date()), treasuryStableAtomic: treasury, repository: new FileRepository(c.stateFile) });
  await center.restore();
  return center;
}
