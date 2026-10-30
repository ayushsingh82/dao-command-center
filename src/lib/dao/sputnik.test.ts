import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SputnikDao, canAct, councilFor, kindLabel, permits, votesNeeded } from "@/lib/dao/sputnik";
import { SputnikError } from "@/lib/dao/types";
import { FakeDao, defaultPolicy } from "@/lib/testing/fake-dao";

const MEMBERS = ["alice.near", "bob.near", "carol.near"];

describe("Sputnik permissions and thresholds", () => {
  it("reads permission strings the way the contract does", () => {
    assert.equal(permits(["*:*"], "vote", "AddProposal"), true);
    assert.equal(permits(["vote:*"], "vote", "VoteApprove"), true);
    assert.equal(permits(["*:VoteApprove"], "call", "VoteApprove"), true);
    assert.equal(permits(["call:VoteApprove"], "vote", "VoteApprove"), false);
    assert.equal(permits(["vote:AddProposal"], "vote", "VoteApprove"), false);
    assert.equal(permits([], "vote", "AddProposal"), false);
  });

  it("names proposal kinds as permissions do", () => {
    assert.equal(kindLabel("Vote"), "vote");
    assert.equal(kindLabel({ FunctionCall: { receiver_id: "x", actions: [] } }), "call");
    assert.equal(kindLabel({ Transfer: { token_id: "", receiver_id: "x", amount: "1" } }), "transfer");
    assert.equal(kindLabel({ AddMemberToRole: {} }), "add_member_to_role");
  });

  it("works out how many approvals a threshold needs", () => {
    assert.equal(votesNeeded("2", 5), 2, "a weight is absolute");
    assert.equal(votesNeeded([1, 2], 3), 2, "half of three, plus one");
    assert.equal(votesNeeded([1, 2], 4), 3);
    assert.equal(votesNeeded([1, 2], 1), 1, "never more than the role has");
    assert.equal(votesNeeded([2, 3], 6), 5);
  });

  it("finds the council and its threshold for a kind of proposal", () => {
    const policy = defaultPolicy(MEMBERS, { threshold: [1, 2] });
    assert.deepEqual(councilFor(policy, "vote"), { members: MEMBERS, threshold: 2 });
    policy.roles[0]!.vote_policy.vote = { threshold: "3" };
    assert.deepEqual(councilFor(policy, "vote"), { members: MEMBERS, threshold: 3 }, "a per-kind policy wins over the default");
    assert.equal(councilFor(policy, "call").threshold, 2);
  });

  it("takes the smallest threshold among the roles that can approve, and ignores roles that cannot", () => {
    const policy = defaultPolicy(["a.near", "b.near"], {
      threshold: "2",
      extraRoles: [
        { name: "fast", kind: { Group: ["c.near"] }, permissions: ["vote:VoteApprove"], vote_policy: { vote: { threshold: "1" } } },
        { name: "watchers", kind: { Group: ["w.near"] }, permissions: ["vote:AddProposal"], vote_policy: {} },
      ],
    });
    const c = councilFor(policy, "vote");
    assert.equal(c.threshold, 1);
    assert.deepEqual(c.members.sort(), ["a.near", "b.near", "c.near"]);
  });

  it("knows who may do what, including an Everyone role", () => {
    const policy = defaultPolicy(MEMBERS, { extraRoles: [{ name: "all", kind: "Everyone", permissions: ["vote:AddProposal"], vote_policy: {} }] });
    assert.equal(canAct(policy, "alice.near", "vote", "VoteApprove"), true);
    assert.equal(canAct(policy, "stranger.near", "vote", "AddProposal"), true);
    assert.equal(canAct(policy, "stranger.near", "vote", "VoteApprove"), false);
  });
});

describe("SputnikDao", () => {
  it("files a proposal with the exact bond and returns its id", async () => {
    const chain = new FakeDao("dao.near", MEMBERS);
    const dao = new SputnikDao("dao.near", chain);
    assert.equal(await dao.file(chain.sender("alice.near"), "hello", "Vote"), 0);
    assert.equal(await dao.file(chain.sender("bob.near"), "again", "Vote"), 1);
    assert.deepEqual((await dao.proposal(1))!.description, "again");
    assert.equal(await dao.proposal(9), null);
    assert.equal((await dao.recent(10)).length, 2);
    assert.equal((await dao.recent(1))[0]!.id, 1);
  });

  it("refuses, before sending, a filer the DAO would refuse", async () => {
    const chain = new FakeDao("dao.near", MEMBERS);
    const dao = new SputnikDao("dao.near", chain);
    await assert.rejects(dao.file(chain.sender("mallory.near"), "x", "Vote"), (e) => e instanceof SputnikError && e.code === "not_allowed");
    assert.equal(chain.proposals.length, 0);
  });

  it("files and approves in one transaction, and a stale id leaves nothing behind", async () => {
    const chain = new FakeDao("dao.near", MEMBERS, { threshold: "1" });
    const dao = new SputnikDao("dao.near", chain);
    const id = await dao.fileAndApprove(chain.sender("alice.near"), "one click", "Vote");
    assert.equal((await dao.proposal(id))!.status, "Approved");

    // The id was read, then another proposal took it: the vote fails and the filing is rolled back.
    const real = chain.view.bind(chain);
    chain.view = (async (c: string, m: string, a?: object) => (m === "get_last_proposal_id" ? 0 : real(c, m, a))) as typeof chain.view;
    await assert.rejects(dao.fileAndApprove(chain.sender("alice.near"), "stale", "Vote"), (e) => e instanceof SputnikError && e.code === "send_failed");
    assert.equal(chain.proposals.length, 1);
  });

  it("votes, echoing the proposal's kind, and the DAO refuses a vote on the wrong kind", async () => {
    const chain = new FakeDao("dao.near", MEMBERS);
    const dao = new SputnikDao("dao.near", chain);
    const id = await dao.file(chain.sender("alice.near"), "x", "Vote");
    await dao.act(chain.sender("alice.near"), id, "VoteApprove");
    assert.deepEqual((await dao.proposal(id))!.votes, { "alice.near": "Approve" });
    await assert.rejects(dao.act(chain.sender("alice.near"), id, "VoteApprove"), /ERR_ALREADY_VOTED/);
    await assert.rejects(dao.act(chain.sender("mallory.near"), id, "VoteApprove"), (e) => e instanceof SputnikError && e.code === "not_allowed");
    await assert.rejects(dao.act(chain.sender("bob.near"), 99, "VoteApprove"), (e) => e instanceof SputnikError && e.code === "no_such_proposal");
    await assert.rejects(chain.sender("bob.near").send("dao.near", [dao.actAction(id, "VoteApprove", { Transfer: { token_id: "", receiver_id: "x", amount: "1" } })]), /ERR_WRONG_KIND/);
  });

  it("says plainly when the account is not a DAO", async () => {
    const chain = new FakeDao("dao.near", MEMBERS);
    await assert.rejects(new SputnikDao("nobody.near", chain).policy(), (e) => e instanceof SputnikError && e.code === "no_such_dao");
  });
});
