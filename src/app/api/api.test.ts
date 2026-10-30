import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { POST as attack } from "@/app/api/attack-test/route";
import { GET as approvalsList } from "@/app/api/approvals/route";
import { POST as decide } from "@/app/api/approvals/[id]/route";
import { GET as books } from "@/app/api/books/route";
import { GET as events } from "@/app/api/events/route";
import { POST as kill } from "@/app/api/kill-switch/route";
import { GET as mandateGet, POST as mandatePost } from "@/app/api/mandate/route";
import { POST as mandatePreview } from "@/app/api/mandate/preview/route";
import { GET as proposals } from "@/app/api/proposals/route";
import { POST as castVote } from "@/app/api/proposals/[id]/vote/route";
import { POST as resume } from "@/app/api/resume/route";
import { POST as retryBank } from "@/app/api/sleeves/[id]/retry-bank/route";
import { POST as openSleeve } from "@/app/api/sleeves/route";
import { POST as governanceMode } from "@/app/api/sim/governance/route";
import { POST as play } from "@/app/api/sim/play/route";
import { POST as reset } from "@/app/api/sim/reset/route";
import { GET as state } from "@/app/api/state/route";
import { POST as tick } from "@/app/api/tick/route";
import { resetRuntime } from "@/lib/command-center/runtime";
import { exampleMandate, RISK } from "@/lib/mandate/example";
import { pricePath } from "@/lib/testing/prices";

const req = (path: string, method: string, body?: unknown) =>
  new Request(`http://test${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
// Test helper: responses are read loosely, and each test asserts the fields it cares about.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as any;
const quiet = { approvalThresholdUsd: "1000000", timelockMs: 3_000 };
const sleeveBody = (over: Record<string, unknown> = {}) => ({ name: "Alpha", stakeUsd: "1000", strategy: { kind: "trend" }, riskAsset: RISK, by: "alice.near", ...over });

beforeEach(async () => {
  await resetRuntime({ mandate: quiet });
});

describe("reading state", () => {
  it("starts with the genesis mandate, no sleeves, and a council", async () => {
    const res = await state();
    assert.equal(res.status, 200);
    const s = await json(res);
    assert.equal(s.mode, "mock");
    assert.equal(s.sleeves.length, 0);
    assert.match(s.mandateDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(s.council.members, ["alice.near", "bob.near", "carol.near"]);
    assert.equal(s.treasury.stableUsd, "20000");
    const m = await json(await mandateGet());
    assert.equal(m.digest, s.mandateDigest);
  });

  it("never sends a grant to the browser, and everything is plain JSON", async () => {
    await openSleeve(req("/api/sleeves", "POST", sleeveBody()));
    const text = await (await state()).text();
    assert.doesNotMatch(text, /ngt_mock|grantToken/);
    JSON.parse(text); // no bigint, no function
  });
});

describe("opening sleeves", () => {
  it("accepts a valid sleeve as a proposal and shows it in state", async () => {
    const res = await openSleeve(req("/api/sleeves", "POST", sleeveBody()));
    assert.equal(res.status, 202);
    assert.equal((await json(res)).proposal.status, "executed");
    const s = await json(await state());
    assert.equal(s.sleeves.length, 1);
    assert.equal(s.treasury.riskBucket.atRiskUsd, "1000");
  });

  it("explains a bad body", async () => {
    const res = await openSleeve(req("/api/sleeves", "POST", { name: "x" }));
    assert.equal(res.status, 400);
    const e = (await json(res)).error;
    assert.equal(e.code, "bad_request");
    assert.match(e.message, /stakeUsd/);
    assert.ok(Array.isArray(e.issues));
  });

  it("rejects a body that is not JSON", async () => {
    const res = await openSleeve(new Request("http://test/api/sleeves", { method: "POST", body: "{nope" }));
    assert.equal(res.status, 400);
    assert.match((await json(res)).error.message, /JSON/);
  });

  it("answers a mandate violation with 422 and the rule that was broken", async () => {
    const res = await openSleeve(req("/api/sleeves", "POST", sleeveBody({ stakeUsd: "9999" })));
    assert.equal(res.status, 422);
    assert.equal((await json(res)).error.code, "stake_exceeds_sleeve_cap");
    assert.equal((await json(await state())).sleeves.length, 0);
  });
});

describe("the mandate", () => {
  it("previews what a change would do to a running sleeve, then proposes it", async () => {
    await openSleeve(req("/api/sleeves", "POST", sleeveBody()));
    const next = exampleMandate({ ...quiet, timelockMs: 77_000 });
    const preview = await json(await mandatePreview(req("/api/mandate/preview", "POST", { mandate: next })));
    assert.deepEqual(preview.sleeves[0].changes.map((c: { path: string }) => c.path), ["timelock_ms"]);

    const res = await mandatePost(req("/api/mandate", "POST", { mandate: next, by: "alice.near" }));
    assert.equal(res.status, 202);
    assert.equal((await json(await state())).mandate.timelockMs, 77_000);
  });

  it("refuses an invalid mandate with every problem listed", async () => {
    const bad = { ...exampleMandate(), maxRiskBucketUsd: "0", bankMultipleBps: 10_000 };
    const res = await mandatePost(req("/api/mandate", "POST", { mandate: bad, by: "alice.near" }));
    assert.equal(res.status, 400);
    const e = (await json(res)).error;
    assert.equal(e.code, "invalid_mandate");
    assert.ok(e.problems.length >= 2);
  });

  it("refuses a malformed mandate before it reaches the domain", async () => {
    const res = await mandatePost(req("/api/mandate", "POST", { mandate: { version: 2 }, by: "alice.near" }));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error.code, "bad_request");
  });
});

describe("governance over HTTP", () => {
  beforeEach(async () => {
    await governanceMode(req("/api/sim/governance", "POST", { autoApprove: false }));
  });

  it("holds a proposal until enough members vote, and maps the rules to status codes", async () => {
    const filed = await json(await openSleeve(req("/api/sleeves", "POST", sleeveBody())));
    assert.equal(filed.proposal.status, "pending");
    const id = filed.proposal.id;

    const first = await json(await castVote(req(`/api/proposals/${id}/vote`, "POST", { member: "alice.near", vote: "approve" }), params({ id })));
    assert.equal(first.proposal.status, "pending");

    const again = await castVote(req(`/api/proposals/${id}/vote`, "POST", { member: "alice.near", vote: "approve" }), params({ id }));
    assert.equal(again.status, 409);
    assert.equal((await json(again)).error.code, "already_voted");

    const outsider = await castVote(req(`/api/proposals/${id}/vote`, "POST", { member: "mallory.near", vote: "approve" }), params({ id }));
    assert.equal(outsider.status, 403);

    const unknown = await castVote(req("/api/proposals/nope/vote", "POST", { member: "bob.near", vote: "approve" }), params({ id: "nope" }));
    assert.equal(unknown.status, 404);

    const second = await json(await castVote(req(`/api/proposals/${id}/vote`, "POST", { member: "bob.near", vote: "approve" }), params({ id })));
    assert.equal(second.proposal.status, "executed");
    assert.equal((await json(await state())).sleeves.length, 1);

    const list = await json(await proposals());
    assert.equal(list.proposals.length, 2, "the genesis mandate and the sleeve");
    assert.deepEqual(list.proposals.map((p: { action: { type: string } }) => p.action.type), ["set_mandate", "open_sleeve"]);
    assert.equal(list.council.threshold, 2);
  });
});

describe("running, the queue, safety, and the books", () => {
  it("plays a rally: the stake is banked, the books close, every attack is refused", async () => {
    await openSleeve(req("/api/sleeves", "POST", sleeveBody()));
    const played = await json(await play(req("/api/sim/play", "POST", { assetId: RISK, prices: pricePath().slice(0, 30), stepMs: 1000 })));
    assert.equal(played.ticks, 30);
    assert.equal(played.snapshot.sleeves[0].exit, "settled");
    assert.equal(played.snapshot.treasury.stableUsd, "20000");

    const b = await json(await books());
    assert.equal(b.reconciled, true);

    const a = await json(await attack(req("/api/attack-test", "POST", {})));
    assert.equal(a.reports[0].passed, true);
    // No body at all is the same as asking for every sleeve.
    const empty = await attack(new Request("http://test/api/attack-test", { method: "POST" }));
    assert.equal(empty.status, 200);
    assert.equal((await json(empty)).reports.length, 1);

    const e = await json(await events(req("/api/events?limit=5", "GET")));
    assert.equal(e.events.length, 5);
    const later = await json(await events(req(`/api/events?after=${e.events.at(-1).seq}`, "GET")));
    assert.equal(later.events.length, 0);
  });

  it("ticks, and shows a large trade waiting in the queue", async () => {
    await resetRuntime({ mandate: { approvalThresholdUsd: "400", timelockMs: 3_000 } });
    await openSleeve(req("/api/sleeves", "POST", sleeveBody()));
    await play(req("/api/sim/play", "POST", { assetId: RISK, prices: [1, 1.5], stepMs: 1000 }));
    const q = await json(await approvalsList(req("/api/approvals?status=pending", "GET")));
    assert.equal(q.approvals.length, 1);
    assert.equal(q.approvals[0].kind, "trade_request");

    const id = encodeURIComponent(q.approvals[0].id);
    const decided = await decide(req(`/api/approvals/${id}`, "POST", { decision: "approve", member: "alice.near" }), params({ id }));
    assert.equal(decided.status, 200);
    assert.equal((await json(decided)).item.status, "executed");

    const missing = await decide(req("/api/approvals/nope", "POST", { decision: "approve", member: "alice.near" }), params({ id: "nope" }));
    assert.equal(missing.status, 404);
    const again = await decide(req(`/api/approvals/${id}`, "POST", { decision: "veto", member: "alice.near" }), params({ id }));
    assert.equal(again.status, 409);

    const t = await json(await tick());
    assert.ok(Array.isArray(t.sleeves));
  });

  it("the kill switch stops everything at once, and resuming is a vote", async () => {
    await openSleeve(req("/api/sleeves", "POST", sleeveBody()));
    const k = await kill(req("/api/kill-switch", "POST", { by: "alice.near", reason: "drill" }));
    assert.equal(k.status, 200);
    assert.equal((await json(k)).frozen, 1);
    assert.equal((await json(await tick())).skipped, "kill_switch");

    const blocked = await openSleeve(req("/api/sleeves", "POST", sleeveBody({ name: "B" })));
    assert.equal(blocked.status, 409);
    assert.equal((await json(blocked)).error.code, "killed");

    const r = await resume(req("/api/resume", "POST", { by: "alice.near" }));
    assert.equal(r.status, 202);
    assert.equal((await json(await state())).killed, null);

    const notOn = await resume(req("/api/resume", "POST", { by: "alice.near" }));
    assert.equal(notOn.status, 409);
    assert.equal((await json(notOn)).error.code, "not_killed");
  });

  it("offers no retry for a sleeve whose exit did not fail, and 404 for one that does not exist", async () => {
    await openSleeve(req("/api/sleeves", "POST", sleeveBody()));
    const none = await retryBank(req("/api/sleeves/s1/retry-bank", "POST", { by: "alice.near" }), params({ id: "s1" }));
    assert.equal(none.status, 409);
    const missing = await retryBank(req("/api/sleeves/zzz/retry-bank", "POST", { by: "alice.near" }), params({ id: "zzz" }));
    assert.equal(missing.status, 404);
  });
});

describe("the mock controls", () => {
  it("reset starts over with the options given", async () => {
    await openSleeve(req("/api/sleeves", "POST", sleeveBody()));
    const res = await reset(req("/api/sim/reset", "POST", { treasuryUsdc: 8000, autoApprove: false }));
    assert.equal(res.status, 200);
    const s = await json(res);
    assert.equal(s.sleeves.length, 0);
    assert.equal(s.treasury.stableUsd, "8000");
    assert.equal(s.council.autoApprove, false);
  });

  it("reset with no body restores the defaults", async () => {
    const res = await reset(new Request("http://test/api/sim/reset", { method: "POST" }));
    assert.equal(res.status, 200);
    assert.equal((await json(res)).treasury.stableUsd, "20000");
  });

  it("refuses a path that is empty or has a bad price", async () => {
    const empty = await play(req("/api/sim/play", "POST", { assetId: RISK, prices: [] }));
    assert.equal(empty.status, 400);
    const negative = await play(req("/api/sim/play", "POST", { assetId: RISK, prices: [1, -2] }));
    assert.equal(negative.status, 400);
  });
});
