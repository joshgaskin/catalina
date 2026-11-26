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

// A load failure at merge-base is red when the module it can't find is one the change adds (#19): the test can't
// pass without the change. Any other load error is not.
function mulIssue(repo, n, testText) {
  repo.git("checkout", "-q", "-b", `issue-${n}`, "origin/main");
  repo.write("src/mul.js", "module.exports = (a, b) => a * b;\n");
  repo.write("test/mul.test.js", testText);
  const fix = repo.commit(`mul (Refs #${n})`);
  repo.write(`.claude/tracking/issue-${n}/tracking.md`, tracking(n));
  repo.write(`.claude/tracking/issue-${n}/verification.jsonl`, verification(fix));
  return repo.commit(`evidence (Refs #${n})`);
}

test("AC3 (#19): a test that fails to load at merge-base only because it imports a module the change adds is red", () => {
  const repo = makeRepo();
  const tip = mulIssue(repo, 121, "const test = require('node:test');\nconst assert = require('node:assert');\nconst mul = require('../src/mul');\ntest('mul', () => assert.strictEqual(mul(2, 3), 6));\n");
  const r = run(repo, 121, { sha: tip });
  assert.deepStrictEqual(r.reasons, []);
  assert.match(r.red.via, /src\/mul\.js/);
});

test("AC3 (#19): ...and it must still pass at the commit", () => {
  const repo = makeRepo();
  const tip = mulIssue(repo, 126, "const test = require('node:test');\nconst assert = require('node:assert');\nconst mul = require('../src/mul');\ntest('mul', () => assert.strictEqual(mul(2, 3), 7));\n");
  assert.ok(has(run(repo, 126, { sha: tip }), /the tests fail at/));
});

test("AC3 (#19): a load error that isn't a module the change adds is not red (control)", () => {
  const repo = makeRepo();
  // Fails to load at main because ./boom throws on require; the change fixes boom. No module is added.
  repo.write("src/boom.js", "throw new Error('boom at load');\n");
  repo.commit("boom");
  repo.git("push", "-q", "origin", "HEAD:main");
  repo.git("checkout", "-q", "-b", "issue-127", "origin/main");
  repo.write("src/boom.js", "module.exports = 1;\n");
  repo.write("test/boom.test.js", "const test = require('node:test');\nconst assert = require('node:assert');\nconst b = require('../src/boom');\ntest('b', () => assert.strictEqual(b, 1));\n");
  const fix = repo.commit("boom fix (Refs #127)");
  repo.write(".claude/tracking/issue-127/tracking.md", tracking(127));
  repo.write(".claude/tracking/issue-127/verification.jsonl", verification(fix));
  const tip = repo.commit("evidence (Refs #127)");
  const r = run(repo, 127, { sha: tip });
  assert.ok(has(r, /failed to load, not an assertion, on main, and not because of a module this change adds \(.*boom at load/), JSON.stringify(r.reasons));
});

// A repo's first code (#14): the merge-base holds no code, so a load failure there is red.
function firstCode(repo, n, testText) {
  repo.git("checkout", "-q", "-b", `issue-${n}`, "origin/main");
  repo.write("src/mul.js", "module.exports = (a, b) => a * b;\n");
  repo.write("test/mul.test.js", testText);
  const fix = repo.commit(`mul (Refs #${n})`);
  repo.write(`.claude/tracking/issue-${n}/tracking.md`, tracking(n));
  repo.write(`.claude/tracking/issue-${n}/verification.jsonl`, verification(fix));
  return repo.commit(`evidence (Refs #${n})`);
}
const MUL_TEST = "const test = require('node:test');\nconst assert = require('node:assert');\nconst mul = require('../src/mul');\ntest('mul', () => assert.strictEqual(mul(2, 3), 6));\n";

test("AC3 (#14): in a repo with no code yet, a test that fails to load at merge-base and passes at the commit is red-green", () => {
  const repo = makeRepo({ noCode: true });
  const tip = firstCode(repo, 123, MUL_TEST);
  const r = run(repo, 123, { sha: tip });
  assert.deepStrictEqual(r.reasons, []);
});

test("AC3 (#14): in a repo with no code yet, the tests must still pass at the commit", () => {
  const repo = makeRepo({ noCode: true });
  const tip = firstCode(repo, 124, MUL_TEST.replace("6)", "7)"));
  assert.ok(has(run(repo, 124, { sha: tip }), /the tests fail at/));
});

test("AC3 (#14): in a repo with no code yet, a test that already passes at merge-base still proves nothing", () => {
  const repo = makeRepo({ noCode: true });
  const tip = firstCode(repo, 125, "const test = require('node:test');\nconst assert = require('node:assert');\ntest('t', () => assert.ok(true));\n");
  assert.ok(has(run(repo, 125, { sha: tip }), /already passes on main, proves nothing/));
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

// AC3b — a record for a fix already on main names its red base, guarded to the fix's parent
function recordAfterFix(repo, n, redBase) {
  repo.write("src/add.js", require("./helpers/repo").FIXED);
  repo.commit(`fix add (#${n})`);
  repo.git("push", "-q", "origin", "main");
  repo.git("checkout", "-q", "-b", `issue-${n}-record`, "origin/main");
  repo.write("test/add.test.js", TEST);
  const pin = repo.commit(`pin add (Refs #${n})`);
  const text = tracking(n) + (redBase ? `\nRed base: ${redBase}\n` : "");
  repo.write(`.claude/tracking/issue-${n}/tracking.md`, text);
  repo.write(`.claude/tracking/issue-${n}/verification.jsonl`, verification(pin));
  return repo.commit(`evidence (Refs #${n})`);
}

test("AC3b: a record for a fix already on main can't prove red against the merge-base", () => {
  const repo = makeRepo();
  const tip = recordAfterFix(repo, 150);
  assert.ok(has(run(repo, 150, { sha: tip }), /already passes on main/));
});

test("AC3b: a Red base line naming the fix's parent proves red, also with the merge-base passed in (audit)", () => {
  const repo = makeRepo();
  const init = repo.git("rev-parse", "origin/main");
  const tip = recordAfterFix(repo, 151, init.slice(0, 9));
  assert.deepStrictEqual(run(repo, 151, { sha: tip }).reasons, []);
  const mb = repo.git("merge-base", tip, "origin/main");
  const r = run(repo, 151, { sha: tip, base: mb, red: "miss" });
  assert.deepStrictEqual(r.reasons, []);
});

test("AC3b: a Red base line pointing anywhere but the fix's parent fails", () => {
  const repo = makeRepo();
  const init = repo.git("rev-parse", "origin/main");
  repo.write("README.md", "more\n");
  repo.commit("unrelated");
  repo.git("push", "-q", "origin", "main");
  // the fix's parent is now the unrelated commit, not init
  const tip = recordAfterFix(repo, 152, init);
  const r = run(repo, 152, { sha: tip });
  assert.ok(has(r, /Red base .* is not the parent of the first commit referencing #152/), JSON.stringify(r.reasons));
  const other = makeRepo();
  const junk = recordAfterFix(other, 153, "deadbeef");
  assert.ok(has(run(other, 153, { sha: junk }), /Red base deadbeef/), "an unknown sha fails too");
});

// plus2 #2943: a JSON fixture under __tests__ matches test_glob, but the runner never reports it
test("#2943 fix 1: a JSON fixture in the change isn't sent to the runner as a test, and is on the red base", () => {
  // vitest's report, as plus2 runs it: a file that throws at load is a load failure, not red
  const repo = makeRepo({
    config: {
      red_cmd: `node --test --test-reporter='${require("./helpers/repo").ROOT}/test/helpers/vitest-json.mjs' --test-reporter-destination={report} {files}`,
      red_parser: "vitest",
    },
  });
  repo.git("checkout", "-q", "-b", "issue-170", "origin/main");
  repo.write("src/add.js", require("./helpers/repo").FIXED);
  // the test reads the fixture, so the fixture must be on the red base too, beside the test
  repo.write("test/add.test.js", TEST.replace("test('adds'", "const sums = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '__tests__/fixtures/sums.json'), 'utf8'));\ntest('fixture', () => assert.strictEqual(sums['2+3'], 5));\ntest('adds'"));
  repo.write("test/__tests__/fixtures/sums.json", '{"2+3":5}\n');
  const fix = repo.commit("fix add (Refs #170)");
  repo.write(".claude/tracking/issue-170/tracking.md", tracking(170));
  repo.write(".claude/tracking/issue-170/verification.jsonl", verification(fix));
  const tip = repo.commit("evidence (Refs #170)");
  const r = run(repo, 170, { sha: tip });
  assert.deepStrictEqual(r.reasons, []);
});

/** Squash-merges branch `from` onto main as PR `number` (its head pushed to refs/pull/<number>/head). */
function squashPR(repo, from, number, message) {
  repo.git("push", "-q", "origin", `HEAD:refs/pull/${number}/head`);
  repo.git("checkout", "-q", "-B", "main", "origin/main");
  repo.git("merge", "-q", "--squash", from);
  const sha = repo.commit(message);
  repo.git("push", "-q", "origin", "HEAD:main");
  return sha;
}

// plus2 #2943: PR #2942 carried one tracking-only #2199 note beside #2796's code; the squash message says Refs #2199
test("#2943 fix 2: a squash whose only #N commit is a tracking note isn't #N's code after the witness", () => {
  const repo = makeRepo();
  buildIssue(repo, 160);
  repo.git("push", "-q", "origin", "HEAD:main");
  repo.git("checkout", "-q", "-b", "pr-9", "origin/main");
  repo.write("src/mul.js", "module.exports = (a, b) => a * b;\n");
  repo.write("test/mul.test.js", "const test = require('node:test');\nconst assert = require('node:assert');\nconst mul = require('../src/mul');\ntest('mul', () => assert.strictEqual(mul(2, 3), 6));\n");
  repo.commit("mul (Refs #161)");
  repo.write(".claude/tracking/issue-160/tracking.md", tracking(160, { review: "re-checked at main" }));
  repo.commit("note (Refs #160)");
  const tip = squashPR(repo, "pr-9", 9, "mul (#9)\n\n* mul (Refs #161)\n\n* note (Refs #160)");
  const r = run(repo, 160, { sha: tip });
  assert.ok(!has(r, /commits after the witnessed sha/), JSON.stringify(r.reasons));

  // a squash where a #160 commit changes code still counts
  repo.git("checkout", "-q", "-b", "pr-10", "origin/main");
  repo.write("src/add.js", "module.exports = (a, b) => b + a;\n");
  repo.commit("add, reordered (Refs #160)");
  const tip2 = squashPR(repo, "pr-10", 10, "reorder (#10)\n\n* add, reordered (Refs #160)");
  assert.ok(has(run(repo, 160, { sha: tip2 }), /commits after the witnessed sha change code \(src\/add\.js\)/));
});

// #36 (plus2 #2796 at c7a11fb): issue A adds a test; a later commit rewrites it to use what only that commit's code
// has. The red proof copies A's own version onto A's base, not the tip's, which can't load there.
function laterRewrite(repo, n, later) {
  buildIssue(repo, n);
  repo.git("push", "-q", "origin", "HEAD:main");
  repo.write("src/add.js", "const add = (a, b) => a + b;\nadd.twice = (a) => add(a, a);\nmodule.exports = add;\n");
  repo.write("test/add.test.js", TEST.replace("test('adds'", "const four = add.twice(2);\ntest('twice', () => assert.strictEqual(four, 4));\ntest('adds'"));
  const tip = repo.commit(`twice (${later})`);
  repo.git("push", "-q", "origin", "HEAD:main");
  return tip;
}

test("#36: another issue's later rewrite of the test doesn't condemn the issue that added it", () => {
  const repo = makeRepo();
  const tip = laterRewrite(repo, 180, "Refs #181");
  const r = run(repo, 180, { sha: tip });
  assert.deepStrictEqual(r.reasons, []);
});

test("#36: the issue's own later rewrite is still the version proven red (control)", () => {
  const repo = makeRepo();
  const tip = laterRewrite(repo, 182, "Refs #182");
  const r = run(repo, 182, { sha: tip });
  assert.ok(has(r, /failed to load, not an assertion, on main, and not because of a module this change adds \(.*twice is not a function/), JSON.stringify(r.reasons));
});

test("#36: a rewrite the issue merged in from main is on its base, so the issue's tip version is the one copied (control)", () => {
  const repo = makeRepo();
  const head = "const test = require('node:test');\nconst assert = require('node:assert');\nconst add = require('../src/add');\n";
  const greets = "const hi = greet();\n// one\n// two\n// three\ntest('greets', () => assert.strictEqual(hi, 'hi'));\n";
  repo.write("src/greet.js", "module.exports = () => 'hi';\n");
  repo.write("test/add.test.js", `${head}const greet = require('../src/greet');\n${greets}`);
  repo.commit("greet");
  repo.git("push", "-q", "origin", "HEAD:main");
  repo.git("checkout", "-q", "-b", "issue-184", "origin/main");
  repo.write("src/add.js", require("./helpers/repo").FIXED);
  repo.write("test/add.test.js", `${head}const greet = require('../src/greet');\n${greets}test('adds', () => assert.strictEqual(add(2, 3), 5));\n`);
  repo.commit("fix add (Refs #184)");
  // meanwhile on main, #185 changes greet's export and the test with it
  repo.git("checkout", "-q", "-b", "issue-185", "origin/main");
  repo.write("src/greet.js", "module.exports = { greet: () => 'hi' };\n");
  repo.write("test/add.test.js", `${head}const { greet } = require('../src/greet');\n${greets}`);
  repo.commit("greet as a named export (Refs #185)");
  repo.git("push", "-q", "origin", "HEAD:main");
  repo.git("checkout", "-q", "issue-184");
  repo.git("merge", "-q", "--no-edit", "origin/main");
  const merged = repo.git("rev-parse", "HEAD");
  repo.write(".claude/tracking/issue-184/tracking.md", tracking(184));
  repo.write(".claude/tracking/issue-184/verification.jsonl", verification(merged));
  const tip = repo.commit("evidence (Refs #184)");
  const r = run(repo, 184, { sha: tip });
  assert.deepStrictEqual(r.reasons, []);
});
