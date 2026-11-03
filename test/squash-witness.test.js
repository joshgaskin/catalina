/**
 * plus2 #2214: a witnessed sha that left the history (the branch was rebased after the witness, or the PR was
 * squash-merged) still counts when a commit there carries the same change. Code no witness covered still fails.
 *
 * Real shapes, 3 Nov 2026: plus2 #2204 and #2202 (witnessed, then rebased; evidence named the pre-rebase sha),
 * #2211 (a later test-only PR on the same issue, after the first PR was squashed).
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { makeRepo, tracking, verification, FIXED, TEST } = require("./helpers/repo");
const { audit } = require("../lib/audit");
const { check } = require("../lib/check");

const STUB = path.join(__dirname, "helpers", "gh-stub.js");
fs.chmodSync(STUB, 0o755);

function withGh(repo, pulls) {
  const file = path.join(repo.tmp, "gh-state.json");
  fs.writeFileSync(file, JSON.stringify({ pulls, issues: [], labels: [] }));
  process.env.CATALINA_GH = STUB;
  process.env.CATALINA_GH_STATE = file;
}

const pushMain = (repo) => repo.git("push", "-q", "origin", "HEAD:main");
const has = (r, re) => r.reasons.some((x) => re.test(x));

/** Issue n on branch issue-n: fix, evidence naming the fix. Main then moves on, and the branch is rebased onto it. */
function witnessedThenRebased(repo, n) {
  repo.git("checkout", "-q", "-b", `issue-${n}`, "origin/main");
  repo.write("src/add.js", FIXED);
  repo.write("test/add.test.js", TEST);
  const witnessed = repo.commit(`fix add (Refs #${n})`);
  repo.write(`.claude/tracking/issue-${n}/tracking.md`, tracking(n));
  repo.write(`.claude/tracking/issue-${n}/verification.jsonl`, verification(witnessed));
  repo.commit(`evidence (Refs #${n})`);
  repo.git("tag", `pre-rebase-${n}`, witnessed); // GitHub (and the audit clone) keep the pre-rebase objects
  repo.git("checkout", "-q", "main");
  repo.write("docs/other.md", "someone else's change\n");
  repo.commit("docs: unrelated");
  pushMain(repo);
  repo.git("checkout", "-q", `issue-${n}`);
  repo.git("rebase", "-q", "origin/main");
  return { witnessed };
}

/** Pushes the branch as PR `number`'s head and squash-merges it onto main. */
function squash(repo, n, number) {
  const head = repo.git("rev-parse", "HEAD");
  repo.git("push", "-q", "origin", `HEAD:refs/pull/${number}/head`);
  repo.git("checkout", "-q", "-B", "main", "origin/main");
  repo.git("merge", "-q", "--squash", `issue-${n}`);
  const sha = repo.commit(`fix add (#${number})\n\nRefs #${n}`);
  pushMain(repo);
  return { head, sha, pr: { number, merge_commit_sha: sha, head: { sha: head, ref: `issue-${n}-fix-add` }, title: "fix add", body: "" } };
}

test("#2214 AC1: audit accepts a witness made before the branch was rebased (the #2204 shape)", () => {
  const repo = makeRepo();
  witnessedThenRebased(repo, 300);
  const m = squash(repo, 300, 9);
  withGh(repo, { [m.sha]: [m.pr] });
  const r = audit({ cwd: repo.cwd, since: "72h", dryRun: true });
  assert.deepStrictEqual(r.findings, []);
});

test("#2214 AC2: code added after the rebase is still a finding, under its real reason (control)", () => {
  const repo = makeRepo();
  witnessedThenRebased(repo, 301);
  repo.write("src/extra.js", "module.exports = 1;\n");
  repo.commit("unwitnessed follow-up (Refs #301)");
  const m = squash(repo, 301, 10);
  withGh(repo, { [m.sha]: [m.pr] });
  const r = audit({ cwd: repo.cwd, since: "72h", dryRun: true });
  assert.strictEqual(r.findings.length, 1, JSON.stringify(r.findings));
  const f = r.findings[0];
  assert.ok(f.reasons.some((x) => /commits after the witnessed sha change code \(src\/extra\.js\)/.test(x)), JSON.stringify(f.reasons));
  assert.ok(!f.reasons.some((x) => /not in the history/.test(x)), JSON.stringify(f.reasons));
});

test("#2214 AC3: check on main after the squash accepts the branch's witness; later code on the issue fails", () => {
  const repo = makeRepo();
  repo.git("checkout", "-q", "-b", "issue-302", "origin/main");
  repo.write("src/add.js", FIXED);
  repo.write("test/add.test.js", TEST);
  const witnessed = repo.commit("fix add (Refs #302)");
  repo.write(".claude/tracking/issue-302/tracking.md", tracking(302));
  repo.write(".claude/tracking/issue-302/verification.jsonl", verification(witnessed));
  repo.commit("evidence (Refs #302)");
  squash(repo, 302, 11);
  repo.write("docs/later.md", "unrelated\n");
  const tip = repo.commit("docs: unrelated, after the squash");
  pushMain(repo);
  const ok = check(302, { cwd: repo.cwd, sha: tip, source: "commit", red: "run" });
  assert.deepStrictEqual(ok.reasons, []);

  repo.write("src/add.js", `${FIXED}// tweak\n`);
  const later = repo.commit("tweak add (Refs #302)");
  pushMain(repo);
  const bad = check(302, { cwd: repo.cwd, sha: later, source: "commit", red: "run" });
  assert.ok(has(bad, /commits after the witnessed sha change code \(src\/add\.js\)/), JSON.stringify(bad.reasons));
});

test("#2214 AC4: a later test-only PR on the issue, still naming the first PR's witness, is a finding (the #2211 shape)", () => {
  const repo = makeRepo();
  witnessedThenRebased(repo, 303);
  const first = squash(repo, 303, 12);
  repo.git("checkout", "-q", "-b", "issue-303-more", "origin/main");
  repo.write("test/add2.test.js", TEST.replace("'adds'", "'adds again'"));
  repo.commit("#303 test: one more case (Refs #303)");
  const second = squash(repo, "303-more", 13);
  withGh(repo, { [first.sha]: [first.pr], [second.sha]: [second.pr] });
  const r = audit({ cwd: repo.cwd, since: "72h", dryRun: true });
  assert.deepStrictEqual(r.findings.map((f) => f.sha), [second.sha], JSON.stringify(r.findings));
  assert.ok(r.findings[0].reasons.some((x) => /commits after the witnessed sha change code \(test\/add2\.test\.js\)/.test(x)), JSON.stringify(r.findings[0].reasons));
});

test("#2214 AC5: a witnessed sha whose change is nowhere in the history still fails as before", () => {
  const repo = makeRepo();
  repo.git("checkout", "-q", "-b", "elsewhere", "origin/main");
  repo.write("src/add.js", "module.exports = (a, b) => b + a;\n");
  const elsewhere = repo.commit("a different change");
  repo.git("checkout", "-q", "-b", "issue-304", "origin/main");
  repo.write("src/add.js", FIXED);
  repo.write("test/add.test.js", TEST);
  repo.commit("fix add (Refs #304)");
  repo.write(".claude/tracking/issue-304/tracking.md", tracking(304));
  repo.write(".claude/tracking/issue-304/verification.jsonl", verification(elsewhere));
  const tip = repo.commit("evidence (Refs #304)");
  const r = check(304, { cwd: repo.cwd, sha: tip, source: "commit", red: "run" });
  assert.ok(has(r, new RegExp(`witnessed sha ${elsewhere.slice(0, 7)} is not in the history of ${tip.slice(0, 7)}`)), JSON.stringify(r.reasons));
});
