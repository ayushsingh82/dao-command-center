import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GovernanceError } from "@/lib/errors";
import { MockGovernance } from "@/lib/governance/mock";

const action = { type: "resume" } as const;
const council = { members: ["ann", "bo", "cy"], threshold: 2 };
const code = (promise: Promise<unknown>, expected: string) =>
  assert.rejects(promise, (e: unknown) => e instanceof GovernanceError && e.code === expected);

describe("MockGovernance", () => {
  it("passes a proposal once enough members approve, and not before", async () => {
    const g = new MockGovernance(council);
    const p = await g.propose(action, "ann", "resume");
    assert.equal(p.status, "pending");
    assert.equal((await g.vote(p.id, "ann", "approve")).status, "pending");
    assert.equal((await g.vote(p.id, "bo", "approve")).status, "approved");
  });

  it("rejects a proposal once it can no longer reach the threshold", async () => {
    const g = new MockGovernance(council);
    const p = await g.propose(action, "ann", "resume");
    assert.equal((await g.vote(p.id, "ann", "reject")).status, "pending");
    assert.equal((await g.vote(p.id, "bo", "reject")).status, "rejected");
  });

  it("only members vote, and only once", async () => {
    const g = new MockGovernance(council);
    const p = await g.propose(action, "ann", "resume");
    await code(g.vote(p.id, "mallory", "approve"), "not_a_member");
    await g.vote(p.id, "ann", "approve");
    await code(g.vote(p.id, "ann", "approve"), "already_voted");
    await code(g.vote("nope", "ann", "approve"), "unknown_proposal");
  });

  it("closes voting once a proposal has passed", async () => {
    const g = new MockGovernance(council);
    const p = await g.propose(action, "ann", "resume");
    await g.vote(p.id, "ann", "approve");
    await g.vote(p.id, "bo", "approve");
    await code(g.vote(p.id, "cy", "approve"), "not_pending");
  });

  it("auto-approve passes a proposal on filing", async () => {
    const g = new MockGovernance({ ...council, autoApprove: true });
    assert.equal((await g.propose(action, "ann", "resume")).status, "approved");
    g.setAutoApprove(false);
    assert.equal((await g.propose(action, "ann", "resume")).status, "pending");
  });

  it("records the outcome once the command center has run a proposal", async () => {
    const g = new MockGovernance({ ...council, autoApprove: true });
    const p = await g.propose(action, "ann", "resume");
    assert.equal((await g.markExecuted(p.id, "t")).status, "executed");
    const q = await g.propose(action, "ann", "resume");
    const failed = await g.markFailed(q.id, "boom", "t");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "boom");
    assert.equal((await g.list()).length, 2);
  });

  it("returns copies, so callers cannot change a proposal by mutating what they got", async () => {
    const g = new MockGovernance(council);
    const p = await g.propose(action, "ann", "resume");
    p.status = "approved";
    assert.equal((await g.get(p.id))!.status, "pending");
  });

  it("rejects an impossible threshold", () => {
    assert.throws(() => new MockGovernance({ members: ["a"], threshold: 2 }));
    assert.throws(() => new MockGovernance({ members: ["a"], threshold: 0 }));
  });
});
