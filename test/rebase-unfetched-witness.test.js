/**
 * #38: a witness made before a rebase, checked in a clone that never fetched the pre-rebase commit.
 *
 * Real shape, plus2 PR 2884 (#2151), 19 Nov 2026: witnessed 8a6af4b, branch rebased, merged through catalina-gh. The
 * gate clone fetches branch heads and the PR head only, so 8a6af4b (still on GitHub) wasn't there and the merge read
 * "witnessed sha 8a6af4b is not in the history of 81d719c". A clone holding the object found the rebased image.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { makeRepo, sh, tracking, verification, FIXED, TEST } = require("./helpers/repo");
const { check } = require("../lib/check");

const STUB = path.join(__dirname, "helpers", "gh-stub.js");
fs.chmodSync(STUB, 0o755);

/** Issue n witnessed on its branch, main moves on, the branch is rebased and force-pushed: only GitHub keeps the witness. */
function rebasedOnRemote(repo, n, o = {}) {
  repo.git("checkout", "-q", "-b", `issue-${n}`, "origin/main");
  repo.write("src/add.js", FIXED);
  repo.write("test/add.test.js", TEST);
  const witnessed = repo.commit(`fix add (Refs #${n})`);
  repo.write(`.claude/tracking/issue-${n}/tracking.md`, tracking(n));
  repo.write(`.claude/tracking/issue-${n}/verification.jsonl`, verification(witnessed.slice(0, 8)));
  repo.commit(`evidence (Refs #${n})`);
  repo.git("push", "-q", "origin", `issue-${n}`);
  // GitHub keeps the pre-rebase objects (and serves them by sha); no branch reaches them after the force-push.
  repo.git("push", "-q", "origin", `${witnessed}:refs/hidden/${n}`);
  repo.git("checkout", "-q", "main");
  repo.write("docs/other.md", "someone else's change\n");
  repo.commit("docs: unrelated");
  repo.git("push", "-q", "origin", "HEAD:main");
  repo.git("checkout", "-q", `issue-${n}`);
  repo.git("rebase", "-q", "origin/main");
  if (o.extra) {
    repo.write("src/extra.js", "module.exports = 1;\n");
    repo.commit(`unwitnessed follow-up (Refs #${n})`);
  }
  repo.git("push", "-q", "-f", "origin", `issue-${n}`);
  sh("git", ["config", "uploadpack.allowAnySHA1InWant", "true"], repo.bare);
  // The merge gate's clone: branch heads only, like catalina-gh's fetch.
  const gate = path.join(repo.tmp, "gate");
  sh("git", ["clone", "-q", "--no-local", `file://${repo.bare}`, gate], repo.tmp);
  const head = sh("git", ["rev-parse", `origin/issue-${n}`], gate).trim();
  const state = path.join(repo.tmp, "gh-state.json");
  fs.writeFileSync(state, JSON.stringify({ pulls: {}, issues: [], labels: [], commits: { [witnessed.slice(0, 8)]: witnessed } }));
  process.env.CATALINA_GH = STUB;
  process.env.CATALINA_GH_STATE = state;
  return { witnessed, gate, head };
}

const opts = (repo, r) => ({ cwd: r.gate, sha: r.head, base: "origin/main", config: { ...repo.config(), remote: "origin", defaultRef: "origin/main", no_undo: [".catalina/**"] } });

test("#38 AC1: a pre-rebase witness the gate clone never fetched is fetched from GitHub and found", () => {
  const repo = makeRepo();
  const r = rebasedOnRemote(repo, 400);
  assert.throws(() => sh("git", ["cat-file", "-e", r.witnessed], r.gate), "precondition: the gate clone lacks the witness");
  const res = check(400, opts(repo, r));
  assert.ok(!res.reasons.some((x) => /not in the history/.test(x)), JSON.stringify(res.reasons));
});

test("#38 AC2: code added after the rebase still fails under its real reason (control)", () => {
  const repo = makeRepo();
  const r = rebasedOnRemote(repo, 401, { extra: true });
  const res = check(401, opts(repo, r));
  assert.ok(res.reasons.some((x) => /commits after the witnessed sha change code \(src\/extra\.js\)/.test(x)), JSON.stringify(res.reasons));
  assert.ok(!res.reasons.some((x) => /not in the history/.test(x)), JSON.stringify(res.reasons));
});

test("#38 AC3: a witnessed sha GitHub doesn't know still fails as not in the history", () => {
  const repo = makeRepo();
  const r = rebasedOnRemote(repo, 402);
  fs.writeFileSync(process.env.CATALINA_GH_STATE, JSON.stringify({ pulls: {}, issues: [], labels: [], commits: {} }));
  const res = check(402, opts(repo, r));
  assert.ok(res.reasons.some((x) => /witnessed sha [0-9a-f]{7} is not in the history/.test(x)), JSON.stringify(res.reasons));
});
