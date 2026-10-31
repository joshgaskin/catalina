const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { makeRepo, buildIssue, tracking, verification, TEST } = require("./helpers/repo");
const { check } = require("../lib/check");

const run = (repo, n, o = {}) => check(n, { cwd: repo.cwd, source: "commit", red: "run", ...o });
const has = (r, re) => r.reasons.some((x) => re.test(x));

// AC1 — complete passes; each missing piece fails with its own reason; uncommitted fixes don't count
test("AC1: a complete issue passes", () => {
  const repo = makeRepo();
  const { tip } = buildIssue(repo, 101);
  const r = run(repo, 101, { sha: tip });
  assert.deepStrictEqual(r.reasons, []);
  assert.strictEqual(r.ok, true);
});

for (const [piece, o, re] of [
  ["DoD", { omit: ["dod"] }, /Definition of Done/],
  ["AC", { omit: ["ac"] }, /no AC found/],
  ["Premortem", { omit: ["premortem"] }, /Premortem/],
  ["Lessons applied", { omit: ["lessons"] }, /Lessons applied/],
  ["AC line", { omit: ["acline"] }, /AC1 has no verification/],
  ["premortem line", { omit: ["pmline"] }, /P1 has no verification/],
  ["witnessed sha", { noSha: true }, /sha/],
]) {
  test(`AC1: missing ${piece} fails`, () => {
    const repo = makeRepo();
    const { tip } = buildIssue(repo, 102, o);
    const r = run(repo, 102, { sha: tip });
    assert.strictEqual(r.ok, false);
    assert.ok(has(r, re), `expected a reason matching ${re}, got ${JSON.stringify(r.reasons)}`);
  });
}

test("AC1: a missing artifact fails", () => {
  const repo = makeRepo();
  repo.git("checkout", "-q", "-b", "issue-103", "origin/main");
  repo.write("src/add.js", require("./helpers/repo").FIXED);
  repo.write("test/add.test.js", TEST);
  const fix = repo.commit("fix (Refs #103)");
  repo.write(".claude/tracking/issue-103/tracking.md", tracking(103).replace("AC1: add returns the sum of two numbers", "AC1: the total renders on the page"));
  repo.write(
    ".claude/tracking/issue-103/verification.jsonl",
    [
      { ac: "AC1: the total renders on the page", result: "pass", method: "visual", artifact: ".claude/tracking/issue-103/evidence/ac1.png", sha: fix },
      { premortem: "P1", outcome: "did_not_occur", evidence: "ok" },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n"
  );
  const tip = repo.commit("evidence (Refs #103)");
  const r = run(repo, 103, { sha: tip });
  assert.ok(has(r, /artifact .* does not exist/), JSON.stringify(r.reasons));
});

test("AC1: an uncommitted fix doesn't change the result for the commit", () => {
  const repo = makeRepo();
  const { tip } = buildIssue(repo, 104, { omit: ["dod"] });
  repo.write(".claude/tracking/issue-104/tracking.md", tracking(104)); // fixed on disk, not committed
  const r = run(repo, 104, { sha: tip });
  assert.ok(has(r, /Definition of Done/));
});

// AC2 — premortem rules
test("AC2: Trivial line passes with no premortem lines", () => {
  const repo = makeRepo();
  const { tip } = buildIssue(repo, 110, { trivial: true });
  assert.deepStrictEqual(run(repo, 110, { sha: tip }).reasons, []);
});

test("AC2: occurred fails", () => {
  const repo = makeRepo();
  const { tip } = buildIssue(repo, 111, { outcome: "occurred" });
  assert.ok(has(run(repo, 111, { sha: tip }), /occurred/));
});

test("AC2: a paraphrased title with the right ID passes, and -- / - dashes are accepted", () => {
  for (const dash of ["--", "-"]) {
    const repo = makeRepo();
    const { tip } = buildIssue(repo, 112, { p1Title: "Something callers depended on", dash });
    assert.deepStrictEqual(run(repo, 112, { sha: tip }).reasons, [], `dash ${dash}`);
  }
});

test("AC2: a premortem with neither IDs nor Trivial fails", () => {
  const repo = makeRepo();
  repo.git("checkout", "-q", "-b", "issue-113", "origin/main");
  repo.write("src/add.js", require("./helpers/repo").FIXED);
  repo.write("test/add.test.js", TEST);
  const fix = repo.commit("fix (Refs #113)");
  repo.write(".claude/tracking/issue-113/tracking.md", tracking(113).replace(/## Premortem\n.*\n/, "## Premortem\n- something might break\n"));
  repo.write(".claude/tracking/issue-113/verification.jsonl", verification(fix, { omit: ["pmline"] }));
  const tip = repo.commit("evidence (Refs #113)");
  assert.ok(has(run(repo, 113, { sha: tip }), /Premortem has no items/));
});

// AC3 — red proof
test("AC3: a test that already passes at merge-base proves nothing", () => {
  const repo = makeRepo({ baseFixed: true });
  const { tip } = buildIssue(repo, 120, { code: false });
  assert.ok(has(run(repo, 120, { sha: tip }), /already passes on main, proves nothing/));
});

test("AC3: a test that fails only because its module is missing at merge-base fails", () => {
  const repo = makeRepo();
  const testText = "const test = require('node:test');\nconst assert = require('node:assert');\nconst mul = require('../src/mul');\ntest('mul', () => assert.strictEqual(mul(2, 3), 6));\n";
  repo.git("checkout", "-q", "-b", "issue-121", "origin/main");
  repo.write("src/mul.js", "module.exports = (a, b) => a * b;\n");
  repo.write("test/mul.test.js", testText);
  const fix = repo.commit("mul (Refs #121)");
  repo.write(".claude/tracking/issue-121/tracking.md", tracking(121));
  repo.write(".claude/tracking/issue-121/verification.jsonl", verification(fix));
  const tip = repo.commit("evidence (Refs #121)");
  assert.ok(has(run(repo, 121, { sha: tip }), /failed to load, not an assertion/));
});

test("AC3: code changed with no test change fails", () => {
  const repo = makeRepo();
  const { tip } = buildIssue(repo, 122, { test: false });
  assert.ok(has(run(repo, 122, { sha: tip }), /code changed with no test change/));
});

test("AC3: a docs-only diff with an exemption passes; the same exemption on code fails", () => {
  const docs = makeRepo();
  const a = buildIssue(docs, 123, { code: false, test: false, docsOnly: true, exempt: "docs only" });
  assert.deepStrictEqual(run(docs, 123, { sha: a.tip }).reasons, []);
  const code = makeRepo();
  const b = buildIssue(code, 124, { test: false, exempt: "no test possible" });
  assert.ok(has(run(code, 124, { sha: b.tip }), /exemption .* code/));
});

test("AC3: a second run with the same sha and tests reads the cache; stale red worktrees are pruned", () => {
  const repo = makeRepo();
  const { tip } = buildIssue(repo, 125);
  const first = run(repo, 125, { sha: tip });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.red.cached, false);
  // A stale leftover from a killed run.
  const stale = path.join(require("os").tmpdir(), `catalina-red-stale-${process.pid}`);
  repo.git("worktree", "add", "-q", "--detach", stale, "origin/main");
  const old = (Date.now() - 3600 * 1000) / 1000;
  fs.utimesSync(stale, old, old);
  const second = run(repo, 125, { sha: tip, red: "miss" });
  assert.strictEqual(second.red.cached, true);
  assert.ok(!repo.git("worktree", "list").includes(stale), "stale worktree pruned");
});

// AC4 — witnessed sha
test("AC4: code committed after the witnessed sha fails", () => {
  const repo = makeRepo();
  buildIssue(repo, 130);
  repo.write("src/extra.js", "module.exports = 1;\n");
  const tip = repo.commit("more code (Refs #130)");
  assert.ok(has(run(repo, 130, { sha: tip }), /commits after the witnessed sha change code/));
});

// AC9 — same failure twice
test("AC9: the same failure at a new sha escalates; a re-run at the same sha doesn't count; ESCALATED clears it", () => {
  const repo = makeRepo();
  const { tip } = buildIssue(repo, 140, { omit: ["dod"] });
  const w = (o = {}) => check(140, { cwd: repo.cwd, source: "worktree", red: "run", witness: true, ...o });
  assert.strictEqual(w().exit, 1);
  assert.strictEqual(w().exit, 1, "same sha again is not a second attempt");
  repo.write(".claude/tracking/issue-140/notes.md", "retry\n");
  repo.commit("retry (Refs #140)");
  const third = w();
  assert.strictEqual(third.exit, 3);
  assert.ok(has(third, /ESCALATE: same failure twice/));
  // pre-push style checks never record attempts
  const before = fs.readFileSync(path.join(repo.cwd, ".claude/tracking/issue-140/attempts.jsonl"), "utf8");
  check(140, { cwd: repo.cwd, source: "commit", red: "run", sha: tip });
  assert.strictEqual(fs.readFileSync(path.join(repo.cwd, ".claude/tracking/issue-140/attempts.jsonl"), "utf8"), before);
  // a human answer clears it
  const t = fs.readFileSync(path.join(repo.cwd, ".claude/tracking/issue-140/tracking.md"), "utf8");
  fs.writeFileSync(path.join(repo.cwd, ".claude/tracking/issue-140/tracking.md"), t.replace("## Review History\n", "## Review History\n- ESCALATED: Josh, add a DoD\n"));
  repo.write(".claude/tracking/issue-140/notes.md", "retry 2\n");
  repo.commit("retry 2 (Refs #140)");
  assert.strictEqual(w().exit, 1);
});
