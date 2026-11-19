/**
 * #28: a replayed mutant proves red for tests that pin a guard main already has. The fixture's base already has the
 * fixed add(), so the issue's test passes there: the normal proof says "already passes on main". A mutant patch that
 * breaks add() again must turn each named test red, leave a test in its file green, and the tests must pass without it.
 *
 * Mutant lines need per-test results, so these fixtures run `node --test` with a reporter that writes vitest's JSON
 * (test/helpers/vitest-json.mjs) and set red_parser "vitest". The witness repros at ec53e69 (A01–A23, B01–B22,
 * F1–F10) are cases here where they still apply.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { makeRepo, buildIssue, sh, BUGGY, FIXED, ROOT } = require("./helpers/repo");
const { check, infraMatcher, runnerReach } = require("../lib/check");

const VITEST = {
  red_cmd: `node --test --test-reporter='${ROOT}/test/helpers/vitest-json.mjs' --test-reporter-destination={report} {files}`,
  red_parser: "vitest",
};
const run = (repo, n, o = {}) => check(n, { cwd: repo.cwd, source: "commit", red: "run", ...o });
const has = (r, re) => r.reasons.some((x) => re.test(x));
const why = (r) => r.reasons.join("\n");
const ADD = "src/add.js";
const T = "test/add.test.js";
const HEAD = "const test = require('node:test');\nconst assert = require('node:assert');\nconst add = require('../src/add');\n";
const ADDS = "test('adds', () => assert.strictEqual(add(2, 3), 5));\n";
const IS_FN = "test('is a function', () => assert.strictEqual(typeof add, 'function'));\n";
const TEST2 = HEAD + ADDS + IS_FN;
const NAME = `${T} > adds`;

/** A real `git diff` of rel rewritten to text (null deletes it), with the tree restored after. */
function diffOf(repo, rel, text) {
  const p = path.join(repo.cwd, rel);
  const before = fs.readFileSync(p, "utf8");
  if (text === null) fs.rmSync(p);
  else fs.writeFileSync(p, text);
  const d = repo.git("diff", "--", rel) + "\n";
  fs.writeFileSync(p, before);
  return d;
}

const newFile = (rel, mode = "100644", body = "x") => `diff --git a/${rel} b/${rel}\nnew file mode ${mode}\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1 @@\n+${body}\n`;
const MUTANT = (repo) => diffOf(repo, ADD, BUGGY);

/** Commit files on main (and the remote), so the issue's base has them. */
function onMain(repo, files) {
  for (const [f, t] of Object.entries(files)) repo.write(f, t);
  repo.commit("base");
  repo.git("push", "-q", "origin", "HEAD:main");
  repo.git("fetch", "-q");
}

/**
 * Issue n on a base that already has the fix: the tests are the only change. Then a tracking commit adds each patch
 * (name -> text, under the tracking dir) and the given verification lines. Returns {tip, dir}.
 */
function guardIssue(repo, n, { patches = {}, lines = [], code, testText = TEST2, extra = {} } = {}) {
  buildIssue(repo, n, { code: false, testText });
  const dir = `.claude/tracking/issue-${n}`;
  const v = path.join(repo.cwd, dir, "verification.jsonl");
  if (code || Object.keys(extra).length) {
    // Commit a code or second test change too (before the tracking commit), naming the sha the AC line names.
    if (code) repo.write(ADD, code);
    for (const [f, t] of Object.entries(extra)) (t === null ? repo.rm(f) : repo.write(f, t));
    const fix = repo.commit(`more (Refs #${n})`);
    fs.writeFileSync(v, fs.readFileSync(v, "utf8").replace(/"sha":"[0-9a-f]+"/g, `"sha":"${fix}"`));
  }
  if (typeof patches === "function") patches = patches(repo);
  for (const [name, text] of Object.entries(patches)) repo.write(`${dir}/${name}`, text);
  fs.appendFileSync(v, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + (lines.length ? "\n" : ""));
  const tip = repo.commit(`mutant (Refs #${n})`);
  return { tip, dir };
}

const line = (o = {}) => ({ red_green: "mutant", patch: "evidence/m.patch", tests: [NAME], reason: "the test pins add(), which main already has", ...o });

function setup(n, o = {}) {
  const repo = makeRepo({ baseFixed: true, config: { ...VITEST, ...o.config } });
  if (o.base) onMain(repo, o.base);
  const patches = o.patches || { "evidence/m.patch": MUTANT(repo) };
  const { tip, dir } = guardIssue(repo, n, { patches, lines: o.lines || [line()], code: o.code, testText: o.testText, extra: o.extra });
  return { repo, tip, dir };
}

const redWorktrees = (repo) => repo.git("worktree", "list").split("\n").filter((l) => /catalina-red-/.test(l));

// AC1 — accepted
test("#28 AC1: a mutant that turns the named test red proves it; the tree is left clean", () => {
  const { repo, tip } = setup(200);
  const r = run(repo, 200, { sha: tip });
  assert.deepStrictEqual(r.reasons, []);
  assert.strictEqual(r.ok, true);
  assert.match(r.red.via, /mutant evidence\/m\.patch/);
  assert.strictEqual(repo.git("status", "--porcelain"), "");
  assert.deepStrictEqual(redWorktrees(repo), []);
});

test("#28 AC1: a test inside a describe is named by its chain; a repo-relative patch path works; a bare string works", () => {
  const t = HEAD + "test.describe('add', () => {\n  test('adds', () => assert.strictEqual(add(2, 3), 5));\n  test('is a function', () => assert.ok(add));\n});\n";
  const { repo, tip } = setup(201, { testText: t, lines: [line({ tests: `${T} > add > adds`, patch: ".claude/tracking/issue-201/evidence/m.patch" })] });
  const r = run(repo, 201, { sha: tip });
  assert.deepStrictEqual(r.reasons, []);
});

test("#28 AC1: --worktree reads the patch and the line from disk, uncommitted", () => {
  const repo = makeRepo({ baseFixed: true, config: VITEST });
  const { tip, dir } = guardIssue(repo, 202);
  repo.write(`${dir}/evidence/m.patch`, MUTANT(repo));
  fs.appendFileSync(path.join(repo.cwd, dir, "verification.jsonl"), JSON.stringify(line()) + "\n");
  const r = check(202, { cwd: repo.cwd, source: "worktree", red: "run", sha: tip });
  assert.deepStrictEqual(r.reasons, []);
});

test("#28 AC1: a test whose body changed in a file main already has counts as changed", () => {
  const weak = HEAD + "test('adds', () => assert.ok(add(2, 3)));\n" + IS_FN;
  const { repo, tip } = setup(203, { base: { [T]: weak } });
  const r = run(repo, 203, { sha: tip });
  assert.deepStrictEqual(r.reasons, []);
});

test("#28 AC1: every mutant line must hold — a second one that survives fails (B19)", () => {
  const repo = makeRepo({ baseFixed: true, config: VITEST });
  const { tip } = guardIssue(repo, 204, {
    patches: { "evidence/m.patch": MUTANT(repo), "evidence/noop.patch": diffOf(repo, ADD, "// a comment\n" + FIXED) },
    lines: [line(), line({ patch: "evidence/noop.patch" })],
  });
  const r = run(repo, 204, { sha: tip });
  assert.strictEqual(r.ok, false);
  assert.ok(has(r, /mutant evidence\/noop\.patch survives: test\/add\.test\.js > adds still passes/), why(r));
});

test("#28 D3: the witness flow — --witness with the lines uncommitted, commit the tracking, then cache mode passes", () => {
  const repo = makeRepo({ baseFixed: true, config: VITEST });
  buildIssue(repo, 205, { code: false, testText: TEST2 });
  const dir = `.claude/tracking/issue-205`;
  repo.write(`${dir}/evidence/m.patch`, MUTANT(repo));
  fs.appendFileSync(path.join(repo.cwd, dir, "verification.jsonl"), JSON.stringify(line()) + "\n");
  const w = check(205, { cwd: repo.cwd, source: "worktree", red: "run", witness: true });
  assert.deepStrictEqual(w.reasons, []);
  fs.rmSync(path.join(repo.cwd, dir, "attempts.jsonl"), { force: true });
  const tip = repo.commit("tracking: mutant (Refs #205)");
  const gate = check(205, { cwd: repo.cwd, source: "commit", red: "cache", sha: tip });
  assert.deepStrictEqual(gate.reasons, []);
  assert.strictEqual(gate.red.cached, true);
});

// AC2 — refused
test("#28 AC2a: a patch that touches a test, a helper, a tracking file, a non-code file or a symlink is refused", () => {
  const plus = (repo, rel) => diffOf(repo, rel, fs.readFileSync(path.join(repo.cwd, rel), "utf8") + "// broken\n");
  for (const [n, extra, re, config] of [
    [210, (repo) => plus(repo, T), /touches test\/add\.test\.js/], // A01, A02
    [211, (repo) => plus(repo, "README.md"), /touches README\.md/], // A05
    [212, () => newFile(".claude/tracking/issue-212/x.js"), /touches \.claude\/tracking\/issue-212\/x\.js/], // A06
    [213, () => newFile("test/want.js"), /touches test\/want\.js/], // F7: a helper test_glob doesn't match
    [214, () => newFile("src/__tests__/kit.js"), /touches src\/__tests__\/kit\.js/], // A03
    [215, () => newFile("src/fixtures/data.js"), /touches src\/fixtures\/data\.js/],
    [216, () => newFile("src/tests/util.js"), /touches src\/tests\/util\.js/],
    [217, () => newFile("src/add.helper.js"), /touches src\/add\.helper\.js/],
    [218, () => newFile("src/add.fixture.js"), /touches src\/add\.fixture\.js/],
    [219, () => newFile("src/support/kit.js"), /touches src\/support\/kit\.js/, { test_helper_glob: ["src/support/**"] }],
    [220, () => newFile("src/lnk.js", "120000", "../test"), /src\/lnk\.js.*symlink/], // A10
  ]) {
    const { repo, tip } = setup(n, { config, patches: (r) => ({ "evidence/m.patch": extra(r) + MUTANT(r) }) });
    const r = run(repo, n, { sha: tip });
    assert.strictEqual(r.ok, false);
    assert.ok(has(r, re), `${n}: ${why(r)}`);
  }
});

test("#28 AC2a: a binary patch is refused: a mutant is a diff a reviewer can read (A15)", () => {
  const { repo, tip } = setup(224, {
    patches: (r) => {
      const p = path.join(r.cwd, ADD);
      fs.writeFileSync(p, Buffer.from([0, 1, 2, 0, 109, 111, 100]));
      const d = sh("git", ["diff", "--binary", "--", ADD], r.cwd);
      fs.writeFileSync(p, FIXED);
      return { "evidence/m.patch": d };
    },
  });
  const r = run(repo, 224, { sha: tip });
  assert.ok(has(r, /mutant evidence\/m\.patch changes src\/add\.js as binary/), why(r));
});

test("#28 AC2b: an empty patch is refused (A12, A18)", () => {
  for (const [i, text] of ["", "\n  \n"].entries()) {
    const { repo, tip } = setup(225 + i, { patches: { "evidence/m.patch": text } });
    const r = run(repo, 225 + i, { sha: tip });
    assert.ok(has(r, /mutant evidence\/m\.patch is empty/), why(r));
  }
});

test("#28 AC2c: a patch that doesn't apply at the sha is refused (A16)", () => {
  const bad = "diff --git a/src/add.js b/src/add.js\n--- a/src/add.js\n+++ b/src/add.js\n@@ -1 +1 @@\n-module.exports = (a, b) => a * b;\n+module.exports = (a, b) => a / b;\n";
  const { repo, tip } = setup(228, { patches: { "evidence/m.patch": bad } });
  const r = run(repo, 228, { sha: tip });
  assert.ok(has(r, /mutant evidence\/m\.patch doesn't apply at/), why(r));
  assert.deepStrictEqual(redWorktrees(repo), []);
});

test("#28 AC2d: a missing patch, a path that leaves the tracking dir, a directory or a symlink is refused (B10–B17, D6)", () => {
  for (const [i, [patch, re]] of [
    ["evidence/nope.patch", /mutant evidence\/nope\.patch: no such file in \.claude\/tracking\/issue-230/],
    ["../issue-1/m.patch", /must be a file under \.claude\/tracking\/issue-231/],
    ["/etc/passwd", /must be a file under \.claude\/tracking\/issue-232/],
    ["", /needs "patch"/],
    ["evidence", /mutant evidence is a directory, not a patch file/],
  ].entries()) {
    const n = 230 + i;
    const { repo, tip } = setup(n, { lines: [line({ patch })] });
    const r = run(repo, n, { sha: tip });
    assert.strictEqual(r.ok, false);
    assert.ok(has(r, re), `${patch}: ${why(r)}`);
  }
  // A patch file that is a symlink, committed (commit mode) and on disk (worktree mode).
  const { repo, tip, dir } = setup(236, { lines: [line({ patch: "evidence/link.patch" })] });
  const real = path.join(repo.tmp, "outside.patch");
  fs.writeFileSync(real, MUTANT(repo));
  fs.symlinkSync(real, path.join(repo.cwd, dir, "evidence/link.patch"));
  const disk = check(236, { cwd: repo.cwd, source: "worktree", red: "run", sha: tip });
  assert.ok(has(disk, /mutant evidence\/link\.patch is a symlink/), why(disk));
  const tip2 = repo.commit("link (Refs #236)");
  const commit = run(repo, 236, { sha: tip2 });
  assert.ok(has(commit, /mutant evidence\/link\.patch is a symlink/), why(commit));
});

test("#28 AC2e: a mutant the named test survives is refused, even when it turns another test red (A11, A22)", () => {
  const repo = makeRepo({ baseFixed: true, config: VITEST });
  const { tip } = guardIssue(repo, 240, { patches: { "evidence/m.patch": diffOf(repo, ADD, "// a comment\n" + FIXED) }, lines: [line()] });
  const r = run(repo, 240, { sha: tip });
  assert.ok(has(r, /mutant evidence\/m\.patch survives: test\/add\.test\.js > adds still passes/), why(r));
  // A22: the mutant breaks adds, but the line names "is a function", which still passes.
  const { repo: r2, tip: t2 } = setup(241, { lines: [line({ tests: [`${T} > is a function`] })] });
  const u = run(r2, 241, { sha: t2 });
  assert.ok(has(u, /survives: test\/add\.test\.js > is a function still passes/), why(u));
});

test("#28 AC2f: a mutant that only breaks loading or crashes the file isn't red (A14, A19, A20, A21, F1)", () => {
  for (const [n, text] of [
    [245, "module.exports = (a, b) => ;\n"], // A19 syntax error
    [246, "throw new Error('AssertionError: at load');\n"], // A20, F1
    [247, "module.exports = (a, b) => { process.exit(1); };\n"], // A21
    [248, null], // A14: delete src/add.js
  ]) {
    const { repo, tip } = setup(n, { patches: (r) => ({ "evidence/m.patch": diffOf(r, ADD, text) }) });
    const r = run(repo, n, { sha: tip });
    assert.strictEqual(r.ok, false);
    assert.ok(has(r, /under mutant evidence\/m\.patch test\/add\.test\.js failed to load or crashed/), `${n}: ${why(r)}`);
  }
});

test("#28 D2: a mutant that fails every test in the file isn't specific (A23)", () => {
  const { repo, tip } = setup(249, { patches: (r) => ({ "evidence/m.patch": diffOf(r, ADD, "module.exports = 5;\n") }) });
  const r = run(repo, 249, { sha: tip });
  assert.ok(has(r, /mutant evidence\/m\.patch is not specific: every test in test\/add\.test\.js fails under it/), why(r));
});

test("#28 AC2g: the named tests must pass at the sha without the mutant", () => {
  const { repo, tip } = setup(250, { code: BUGGY });
  const r = run(repo, 250, { sha: tip });
  assert.ok(has(r, /fail at [0-9a-f]{7} without the mutant/), why(r));
});

test("#28 AC2h: tests must name changed test cases, as <file> > <describe…> > <title> (B01–B06, D1)", () => {
  for (const [i, [tests, re, base]] of [
    [["test/other.test.js > x"], /names test\/other\.test\.js > x, which isn't in a test file this change adds or changes/],
    [["src/add.js > adds"], /names src\/add\.js > adds, which isn't in a test file this change adds or changes/],
    [[], /names no test/],
    [null, /names no test/],
    [[T], /"test\/add\.test\.js" names a file, not a test/],
    [[`${T} > subtracts`], /test\/add\.test\.js > subtracts: no such test in test\/add\.test\.js/],
    [[`${T} > is a function`], /test\/add\.test\.js > is a function isn't new or changed since the base/, { [T]: HEAD + IS_FN }],
  ].entries()) {
    const n = 251 + i;
    const { repo, tip } = setup(n, { lines: [line({ tests })], base });
    const r = run(repo, n, { sha: tip });
    assert.strictEqual(r.ok, false);
    assert.ok(has(r, re), `${JSON.stringify(tests)}: ${why(r)}`);
  }
});

test("#28 AC2i: a mutant line needs a reason, as a non-empty string (B07–B09)", () => {
  for (const [i, reason] of [undefined, " ", true, 5].entries()) {
    const { repo, tip } = setup(260 + i, { lines: [line({ reason })] });
    const r = run(repo, 260 + i, { sha: tip });
    assert.ok(has(r, /mutant evidence\/m\.patch needs a "reason"/), `${reason}: ${why(r)}`);
  }
});

test("#28 D1: a runner without per-test results refuses the mutant line", () => {
  const { repo, tip } = setup(265, { config: { red_cmd: "node --test {files}", red_parser: "node-test" } });
  const r = run(repo, 265, { sha: tip });
  assert.ok(has(r, /mutant lines need per-test results, and red_parser "node-test" can't give them/), why(r));
});

// D4 — every changed test file needs proof
test("#28 D4: a changed test file that passes at the base and no mutant line names fails, naming it (F8)", () => {
  const vac = "const test = require('node:test');\nconst assert = require('node:assert');\ntest('vacuous', () => assert.ok(true));\n";
  const { repo, tip } = setup(270, { extra: { "test/vac.test.js": vac } });
  const r = run(repo, 270, { sha: tip });
  assert.ok(has(r, /test\/vac\.test\.js already passes on main and no mutant line names a test in it/), why(r));
  assert.ok(!has(r, /test\/add\.test\.js/), why(r));
  // A buggy base: add.test.js is red there, vac.test.js isn't; the same with each parser.
  for (const [n, config] of [[271, {}], [272, VITEST]]) {
    const repo2 = makeRepo({ config });
    buildIssue(repo2, n, { testText: TEST2 });
    repo2.write("test/vac.test.js", vac);
    const fix = repo2.commit(`vac (Refs #${n})`);
    const v = path.join(repo2.cwd, `.claude/tracking/issue-${n}/verification.jsonl`);
    fs.writeFileSync(v, fs.readFileSync(v, "utf8").replace(/"sha":"[0-9a-f]+"/g, `"sha":"${fix}"`));
    const tip2 = repo2.commit(`evidence (Refs #${n})`);
    const r2 = run(repo2, n, { sha: tip2 });
    assert.ok(has(r2, /test\/vac\.test\.js already passes on main/), `${n}: ${why(r2)}`);
    assert.ok(!has(r2, /test\/add\.test\.js already passes/), `${n}: ${why(r2)}`);
  }
});

test("#28 D4: a base-red file and a mutant-proven file together pass", () => {
  const repo = makeRepo({ config: VITEST }); // buggy base: add.test.js is red there
  buildIssue(repo, 275, { testText: TEST2 });
  const arity = HEAD + "test('takes two numbers', () => assert.strictEqual(add.length, 2));\n" + IS_FN;
  repo.write("test/arity.test.js", arity);
  const fix = repo.commit("arity (Refs #275)");
  const dir = ".claude/tracking/issue-275";
  const v = path.join(repo.cwd, dir, "verification.jsonl");
  fs.writeFileSync(v, fs.readFileSync(v, "utf8").replace(/"sha":"[0-9a-f]+"/g, `"sha":"${fix}"`));
  repo.write(`${dir}/evidence/m.patch`, diffOf(repo, ADD, "module.exports = (a) => a;\n"));
  fs.appendFileSync(v, JSON.stringify(line({ tests: ["test/arity.test.js > takes two numbers"] })) + "\n");
  const tip = repo.commit(`mutant (Refs #275)`);
  const r = run(repo, 275, { sha: tip });
  assert.deepStrictEqual(r.reasons, []);
});

// AC3 — scope
test("#28 AC3: when the test fails at the base, the normal proof holds and a mutant line is ignored", () => {
  const repo = makeRepo(); // buggy base: the normal fix
  buildIssue(repo, 280);
  const noop = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-fixture\n+x\n";
  repo.write(".claude/tracking/issue-280/evidence/m.patch", noop);
  fs.appendFileSync(path.join(repo.cwd, ".claude/tracking/issue-280/verification.jsonl"), JSON.stringify(line()) + "\n");
  const tip = repo.commit("mutant (Refs #280)");
  const r = run(repo, 280, { sha: tip });
  assert.deepStrictEqual(r.reasons, []);
  assert.ok(!/mutant/.test(r.red.via || ""));
});

test("#28 AC3: a mutant doesn't rescue a load error at the base", () => {
  const repo = makeRepo({ baseFixed: true, config: VITEST });
  const t = "const test = require('node:test');\nrequire('no-such-package');\ntest('x', () => {});\n";
  buildIssue(repo, 282, { code: false, testText: t });
  repo.write(".claude/tracking/issue-282/evidence/m.patch", MUTANT(repo));
  fs.appendFileSync(path.join(repo.cwd, ".claude/tracking/issue-282/verification.jsonl"), JSON.stringify(line()) + "\n");
  const tip = repo.commit("mutant (Refs #282)");
  const r = run(repo, 282, { sha: tip });
  assert.ok(has(r, /failed to load, not an assertion, on main/), why(r));
  assert.ok(!has(r, /mutant/), why(r));
});

test("#28 AC3: with no mutant line, 'already passes on main' names the mutant way out", () => {
  const { repo, tip } = setup(284, { lines: [] });
  const r = run(repo, 284, { sha: tip });
  assert.ok(has(r, /already passes on main, proves nothing.*"red_green":"mutant".*"tests":\["<file> > <describe> > <test>"\]/), why(r));
});

// AC4 — cache
test("#28 AC4: the mutant verdict is cached; a changed patch is a miss; cache mode doesn't run", () => {
  const { repo, tip, dir } = setup(290);
  const first = run(repo, 290, { sha: tip });
  assert.strictEqual(first.ok, true, why(first));
  assert.strictEqual(first.red.cached, false);
  const second = run(repo, 290, { sha: tip, red: "miss" });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.red.cached, true);
  repo.write(`${dir}/evidence/m.patch`, diffOf(repo, ADD, "module.exports = (a, b) => a * b;\n"));
  const tip2 = repo.commit("another mutant (Refs #290)");
  const cacheOnly = run(repo, 290, { sha: tip2, red: "cache" });
  assert.ok(has(cacheOnly, /mutant evidence\/m\.patch not run yet/), why(cacheOnly));
  const third = run(repo, 290, { sha: tip2, red: "miss" });
  assert.strictEqual(third.ok, true, why(third));
  assert.strictEqual(third.red.cached, false);
});

test("#28 D3: a tracking-only commit hits the cache; a change to a file the patch touches misses", () => {
  const { repo, tip, dir } = setup(292);
  assert.strictEqual(run(repo, 292, { sha: tip }).ok, true);
  repo.write(`${dir}/notes.md`, "more evidence\n");
  const tip2 = repo.commit("tracking (Refs #292)");
  const hit = run(repo, 292, { sha: tip2, red: "cache" });
  assert.deepStrictEqual(hit.reasons, []);
  assert.strictEqual(hit.red.cached, true);
  repo.write(ADD, "module.exports = (a, b) => b + a;\n");
  const tip3 = repo.commit("touch add (Refs #292)");
  const miss = run(repo, 292, { sha: tip3, red: "cache" });
  assert.ok(has(miss, /mutant evidence\/m\.patch not run yet/), why(miss));
});

test("#28 D6: a cache hit names the patch the record names now (F5)", () => {
  const { repo, tip, dir } = setup(294);
  assert.strictEqual(run(repo, 294, { sha: tip }).ok, true);
  fs.renameSync(path.join(repo.cwd, dir, "evidence/m.patch"), path.join(repo.cwd, dir, "evidence/renamed.patch"));
  const v = path.join(repo.cwd, dir, "verification.jsonl");
  fs.writeFileSync(v, fs.readFileSync(v, "utf8").replace("evidence/m.patch", "evidence/renamed.patch"));
  const tip2 = repo.commit("rename (Refs #294)");
  const r = run(repo, 294, { sha: tip2, red: "cache" });
  assert.deepStrictEqual(r.reasons, []);
  assert.strictEqual(r.red.cached, true);
  assert.match(r.red.via, /evidence\/renamed\.patch/);
  assert.doesNotMatch(r.red.via, /evidence\/m\.patch/);
});

test("#28 AC4: verdicts cached before this rule (v4) re-run, a green one too", () => {
  const { repo, tip } = setup(296);
  assert.strictEqual(run(repo, 296, { sha: tip }).ok, true);
  const cache = path.join(repo.tmp, "state", "o__r", "red-cache");
  // The mutant's entry, marked as written before v5 (a v4 base verdict here was a failing basePass, already a miss).
  let forged = 0;
  for (const f of fs.readdirSync(cache)) {
    const p = path.join(cache, f);
    const e = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!/mutant/.test(e.via || "")) continue;
    fs.writeFileSync(p, JSON.stringify({ ...e, ok: true, v: 4 }));
    forged++;
  }
  assert.strictEqual(forged, 1);
  const r = run(repo, 296, { sha: tip, red: "miss" });
  assert.deepStrictEqual(r.reasons, []);
  assert.strictEqual(r.red.cached, false);
});

test("#28 D4: a green base verdict over several files cached before v5 re-runs; over one file it still hits", () => {
  const cacheOf = (repo) => path.join(repo.tmp, "state", "o__r", "red-cache");
  const age = (repo) => {
    for (const f of fs.readdirSync(cacheOf(repo))) {
      const p = path.join(cacheOf(repo), f);
      fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, "utf8")), v: 4 }));
    }
  };
  const two = makeRepo();
  buildIssue(two, 298, { testText: TEST2 });
  two.write("test/sub.test.js", HEAD + "test('adds again', () => assert.strictEqual(add(1, 1), 2));\n");
  const tip = two.commit("second test (Refs #298)");
  const v = path.join(two.cwd, ".claude/tracking/issue-298/verification.jsonl");
  fs.writeFileSync(v, fs.readFileSync(v, "utf8").replace(/"sha":"[0-9a-f]+"/g, `"sha":"${tip}"`));
  const tip2 = two.commit("evidence (Refs #298)");
  assert.strictEqual(run(two, 298, { sha: tip2 }).ok, true);
  age(two);
  assert.strictEqual(run(two, 298, { sha: tip2, red: "miss" }).red.cached, false);
  const one = makeRepo();
  const { tip: t1 } = buildIssue(one, 299);
  assert.strictEqual(run(one, 299, { sha: t1 }).ok, true);
  age(one);
  assert.strictEqual(run(one, 299, { sha: t1, red: "miss" }).red.cached, true);
});

// Witness 2 at 03ccf47: jest, cosmetic "changes", test infrastructure, patches that reach into the runner, a run that
// aborts, and specificity per test.
const JEST = {
  red_cmd: `node --test --test-reporter='${ROOT}/test/helpers/jest-json.mjs' --test-reporter-destination={report} {files}`,
  red_parser: "jest",
};
const OLD = HEAD + "describe('add', () => {\n  test('adds', () => {\n    assert.strictEqual(add(2, 3), 5);\n  });\n  test('is a function', () => {\n    assert.strictEqual(typeof add, 'function');\n  });\n});\n";
const DHEAD = HEAD.replace("const test = require('node:test');", "const { describe, test } = require('node:test');");
const OLD_D = OLD.replace(HEAD, DHEAD);
const VAC = "  test('vacuous new', () => {\n    assert.ok(true);\n  });\n";
const withVac = (t) => t.replace("describe('add', () => {\n", "describe('add', () => {\n" + VAC);

test("#28 D-J: under jest, a good mutant passes though jest sets the file's message whenever a test fails (J1)", () => {
  const { repo, tip } = setup(300, { config: JEST });
  const r = run(repo, 300, { sha: tip });
  assert.deepStrictEqual(r.reasons, []);
  assert.match(r.red.via, /mutant evidence\/m\.patch/);
});

test("#28 D-J: under jest, a mutant that breaks loading is still a crash", () => {
  const { repo, tip } = setup(301, { config: JEST, patches: (r) => ({ "evidence/m.patch": diffOf(r, ADD, "module.exports = (a, b) => ;\n") }) });
  const r = run(repo, 301, { sha: tip });
  assert.ok(has(r, /under mutant evidence\/m\.patch test\/add\.test\.js failed to load or crashed/), why(r));
});

test("#28 D-static: a whitespace, comment or move edit to an old test isn't a change (N01, N02, N03)", () => {
  const lines = OLD_D.split("\n");
  const moved = [...lines.slice(0, 4), ...lines.slice(7, 10), ...lines.slice(4, 7), ...lines.slice(10)].join("\n");
  for (const [n, text] of [
    [302, OLD_D.replace("    assert.strictEqual(add(2, 3), 5);", "    assert.strictEqual(add(2, 3), 5); ")],
    [303, OLD_D.replace("    assert.strictEqual(add(2, 3), 5);", "    // pins add\n    assert.strictEqual(add(2, 3), 5);")],
    [304, OLD_D.replace("    assert.strictEqual(add(2, 3), 5);", "    assert.strictEqual(\n      add(2, 3),\n      5,\n    );")],
    [305, moved],
  ]) {
    const { repo, tip } = setup(n, { base: { [T]: OLD_D }, testText: withVac(text), lines: [line({ tests: [`${T} > add > adds`] })] });
    const r = run(repo, n, { sha: tip });
    assert.strictEqual(r.ok, false, `${n}`);
    assert.ok(has(r, /test\/add\.test\.js > add > adds isn't new or changed since the base/), `${n}: ${why(r)}`);
  }
});

test("#28 D-static: renaming a describe or a title around an old test body isn't a change (N04)", () => {
  for (const [n, text, name] of [
    [306, OLD_D.replace("describe('add'", "describe('add()'"), "add() > adds"],
    [307, OLD_D.replace("test('adds'", "test('adds two numbers'"), "add > adds two numbers"],
  ]) {
    const { repo, tip } = setup(n, { base: { [T]: OLD_D }, testText: text, lines: [line({ tests: [`${T} > ${name}`] })] });
    const r = run(repo, n, { sha: tip });
    assert.ok(has(r, /isn't new or changed since the base/), `${n}: ${why(r)}`);
  }
});

test("#28 D-static: a changed literal in an old test's body is a change", () => {
  const changed = OLD_D.replace("assert.strictEqual(add(2, 3), 5);", "assert.strictEqual(add(2, 4), 6);");
  const { repo, tip } = setup(308, { base: { [T]: OLD_D }, testText: changed, lines: [line({ tests: [`${T} > add > adds`] })] });
  const r = run(repo, 308, { sha: tip });
  assert.deepStrictEqual(r.reasons, []);
});

test("#28 D-static: a name a computed-title test could also report is refused (N12)", () => {
  const before = HEAD + "const name = 'adds';\ntest(name, () => assert.strictEqual(add(2, 3), 5));\n" + IS_FN;
  const after = before + "if (false) test('adds', () => assert.ok(true));\n";
  const { repo, tip } = setup(309, { base: { [T]: before }, testText: after });
  const r = run(repo, 309, { sha: tip });
  assert.strictEqual(r.ok, false);
  assert.ok(has(r, /test\/add\.test\.js > adds: a test with a computed title could report the same name/), why(r));
});

test("#28 D-static: a second base-pass file whose only named test changed by whitespace fails (N19)", () => {
  const oldT = HEAD + "test('old', () => {\n  assert.strictEqual(add(1, 2), 3);\n});\n";
  const { repo, tip } = setup(310, {
    base: { "test/old.test.js": oldT },
    extra: { "test/old.test.js": oldT.replace("3);\n", "3);  \n") + "test('vac', () => assert.ok(true));\n" },
    lines: [line(), line({ tests: ["test/old.test.js > old"] })],
  });
  const r = run(repo, 310, { sha: tip });
  assert.strictEqual(r.ok, false);
  assert.ok(has(r, /test\/old\.test\.js > old isn't new or changed since the base/), why(r));
});

test("#28 D-helpers: a patch that touches test infrastructure is refused, naming the file (N20–N22)", () => {
  for (const [i, [rel, config]] of [
    ["src/__mocks__/add.js"],
    ["vitest.setup.js"],
    ["jest.setup.ts"],
    ["src/add.setup.mjs"],
    ["setupTests.js"],
    ["src/setup-env.cjs"],
    ["src/test-utils.js"],
    ["src/testutils/index.js"],
    ["src/test-utils/render.js"],
    ["src/__fixtures__/data.js"],
    ["vitest.config.mjs"],
    ["vite.config.ts"],
    ["jest.config.js"],
    ["vitest.workspace.ts"],
  ].entries()) {
    const n = 311 + i;
    const { repo, tip } = setup(n, { config, patches: (r) => ({ "evidence/m.patch": newFile(rel) + MUTANT(r) }) });
    const r = run(repo, n, { sha: tip });
    assert.strictEqual(r.ok, false, rel);
    const esc = rel.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    assert.ok(has(r, new RegExp(`mutant evidence/m\\.patch touches ${esc} \\(test infrastructure`)), `${rel}: ${why(r)}`);
  }
});

test("#28 V4, N14: a patch whose added lines reach into the test runner or an assertion library is refused", () => {
  for (const [i, added] of [
    'import { beforeEach } from "vitest";', // V4
    "require('node:assert').ok = () => { throw new Error('nope'); };", // N14
    "const { expect } = require('@jest/globals');",
    "const assert = require('assert');",
    "const { assert: chai } = require('chai');",
    "const t = require('node:test');",
    "const v = await import('vitest');",
    "beforeEach(() => { throw new Error('x'); });",
    "afterAll(() => {});",
    "globalThis.beforeAll?.(() => {});",
    "expect.extend({ toBe: () => ({ pass: false }) });",
    "assert.strictEqual = () => { throw new Error('x'); };",
  ].entries()) {
    const n = 330 + i;
    const { repo, tip } = setup(n, { patches: (r) => ({ "evidence/m.patch": diffOf(r, ADD, added + "\n" + BUGGY) }) });
    const r = run(repo, n, { sha: tip });
    assert.strictEqual(r.ok, false, added);
    assert.ok(has(r, /mutant evidence\/m\.patch reaches into the test runner: src\/add\.js adds /), `${added}: ${why(r)}`);
  }
  // Words that only look like it: an `expected` local, an assertValid() call, a comment.
  const fine = "const expected = (a, b) => a - b; // not expect.anything\nconst assertValid = (x) => x;\nmodule.exports = (a, b) => assertValid(expected(a, b));\n";
  const { repo, tip } = setup(345, { patches: (r) => ({ "evidence/m.patch": diffOf(r, ADD, fine) }) });
  const ok = run(repo, 345, { sha: tip });
  assert.deepStrictEqual(ok.reasons, []);
});

test("#28 A21: a base test missing from the run under the mutant is a crash", () => {
  // The mutant stops 'is a function' from registering: the run ended early as far as the report can tell.
  const t = HEAD + ADDS + "if (!add.halt) test('is a function', () => assert.strictEqual(typeof add, 'function'));\ntest('adds again', () => assert.strictEqual(add(1, 1), 2));\ntest('is callable', () => assert.ok(add.call));\n";
  const mutant = (r) => ({ "evidence/m.patch": diffOf(r, ADD, BUGGY + "module.exports.halt = true;\n") });
  const { repo, tip } = setup(346, { testText: t, patches: mutant });
  const r = run(repo, 346, { sha: tip });
  assert.strictEqual(r.ok, false);
  assert.ok(has(r, /under mutant evidence\/m\.patch test\/add\.test\.js failed to load or crashed: 1 of its 4 tests didn't run \(is a function\)/), why(r));
});

test("#28 A21: a test that fails because the code called process.exit is a crash (vitest's message)", () => {
  const exit = "module.exports = (a, b) => { throw new Error('process.exit unexpectedly called with \"1\"'); };\nmodule.exports.ok = 1;\n";
  const t = HEAD + ADDS + IS_FN + "test('has ok', () => assert.ok(add.ok || true));\n";
  const { repo, tip } = setup(347, { testText: t, patches: (r) => ({ "evidence/m.patch": diffOf(r, ADD, exit) }) });
  const r = run(repo, 347, { sha: tip });
  assert.ok(has(r, /under mutant evidence\/m\.patch test\/add\.test\.js failed to load or crashed: adds called process\.exit/), why(r));
  // W08c: a guard whose regression is an exit is proven by a test that spies on process.exit; the refusal says how.
  assert.ok(has(r, /spy on process\.exit/), why(r));
});

test("#28 W08c: a mutant that really exits the test process gets the process.exit hint too (node:test reports no test)", () => {
  const exit = "module.exports = (a, b) => process.exit(1);\n";
  const t = HEAD + ADDS + IS_FN;
  const { repo, tip } = setup(372, { testText: t, patches: (r) => ({ "evidence/m.patch": diffOf(r, ADD, exit) }) });
  const r = run(repo, 372, { sha: tip });
  assert.strictEqual(r.ok, false);
  assert.ok(has(r, /test\/add\.test\.js failed to load or crashed: it reported no test/), why(r));
  assert.ok(has(r, /spy on process\.exit/), why(r));
});

test("#28 AC7: at least half of the file's other passing tests must still pass under the mutant (A23, N13, N00, N11)", () => {
  const throws = (r) => ({ "evidence/m.patch": diffOf(r, ADD, "module.exports = (a, b) => { throw new Error('boom'); };\n") });
  // 1 of 3 others still passes: under half.
  const third = HEAD + ADDS + "test('adds negatives', () => assert.strictEqual(add(-2, -3), -5));\ntest('adds zero', () => assert.strictEqual(add(0, 3), 3));\ntest('trivial', () => {});\n";
  const { repo, tip } = setup(348, { testText: third, patches: throws });
  const r = run(repo, 348, { sha: tip });
  assert.strictEqual(r.ok, false);
  assert.ok(has(r, /mutant evidence\/m\.patch is not specific: only 1 of the 3 other tests in test\/add\.test\.js that pass without it still pass with it — a mutant that breaks one guard leaves at least half of the others passing/), why(r));
  // N13, N00, N11: 1 of 2 others still passes: half is enough.
  const half = HEAD + ADDS + "test('adds negatives', () => assert.strictEqual(add(-2, -3), -5));\ntest('trivial', () => {});\n";
  const { repo: r2, tip: t2 } = setup(349, { testText: half, patches: throws });
  assert.deepStrictEqual(run(r2, 349, { sha: t2 }).reasons, []);
});

test("#28 AC7: a file whose only passing tests are the named ones can't show the mutant is specific", () => {
  const { repo, tip } = setup(350, { testText: HEAD + ADDS });
  const r = run(repo, 350, { sha: tip });
  assert.ok(has(r, /mutant evidence\/m\.patch is not specific: test\/add\.test\.js has no other test that passes without it/), why(r));
});

// Witness 3 (round 3). The check catches honest but wrong mutant lines; it doesn't stop a hostile witness (the
// reviewer reads every patch). These are the cases in scope.

const NOOP = (r) => ({ "evidence/m.patch": diffOf(r, ADD, "// add two numbers\n" + FIXED) });
const OLD_W = HEAD + "test.describe('add', () => {\n  test('adds', () => {\n    assert.strictEqual(add(2, 3), 5);\n  });\n  test('is a function', () => {\n    assert.strictEqual(typeof add, 'function');\n  });\n});\n";

test("#28 W01: each run gets a fresh checkout, so a test that leaves a file behind can't fail the mutant run for it", () => {
  const t = "const fs = require('node:fs');\nconst path = require('node:path');\n" + HEAD +
    "test('writes the sum', () => {\n  const p = path.join(__dirname, 'sum.txt');\n  assert.ok(!fs.existsSync(p), 'sum.txt already there');\n  fs.writeFileSync(p, String(add(2, 3)));\n});\n" + ADDS + IS_FN;
  const { repo, tip } = setup(360, { testText: t, patches: NOOP, lines: [line({ tests: [`${T} > writes the sum`] })] });
  const r = run(repo, 360, { sha: tip });
  assert.strictEqual(r.ok, false);
  assert.ok(has(r, /mutant evidence\/m\.patch survives: test\/add\.test\.js > writes the sum still passes/), why(r));
  assert.deepStrictEqual(redWorktrees(repo), []);
});

test("#28 W01 with red_pool: the reused checkout is reset between runs, so the file a test leaves behind still can't reach the next", () => {
  const POOL = { red_setup: "mkdir -p deps", red_pool: { keep: ["deps"] } };
  const t = "const fs = require('node:fs');\nconst path = require('node:path');\n" + HEAD +
    "test('writes the sum', () => {\n  const p = path.join(__dirname, 'sum.txt');\n  assert.ok(!fs.existsSync(p), 'sum.txt already there');\n  fs.writeFileSync(p, String(add(2, 3)));\n});\n" + ADDS + IS_FN;
  const leaky = setup(362, { config: POOL, testText: t, patches: NOOP, lines: [line({ tests: [`${T} > writes the sum`] })] });
  const r = run(leaky.repo, 362, { sha: leaky.tip });
  assert.ok(has(r, /mutant evidence\/m\.patch survives: test\/add\.test\.js > writes the sum still passes/), why(r));
  // and a real mutant is still proven in the pool's one checkout
  const real = setup(363, { config: POOL });
  const ok = run(real.repo, 363, { sha: real.tip });
  assert.deepStrictEqual(ok.reasons, [], why(ok));
  assert.match(ok.red.via, /mutant evidence\/m\.patch/);
});

test("#28 W01b, W11: the clean run runs twice and must agree; a flaky pair is refused and never cached", () => {
  const os = require("os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catalina-flaky-"));
  try {
    const counter = JSON.stringify(path.join(tmp, "n"));
    const t = "const fs = require('node:fs');\n" + HEAD +
      `test('caches the sum', () => {\n  const p = ${counter};\n  const k = fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : 0;\n  fs.writeFileSync(p, String(k + 1));\n  assert.strictEqual(k % 2 === 0 ? add(2, 3) : 0, 5);\n});\n` + ADDS + IS_FN;
    const { repo, tip } = setup(361, { testText: t, patches: NOOP, lines: [line({ tests: [`${T} > caches the sum`] })] });
    const flaky = /mutant evidence\/m\.patch: test\/add\.test\.js gives a different result each run without the mutant \(caches the sum\), so a failure under it proves nothing — make the tests deterministic/;
    const r = run(repo, 361, { sha: tip });
    assert.strictEqual(r.ok, false);
    assert.ok(has(r, flaky), why(r));
    const again = run(repo, 361, { sha: tip, red: "miss" });
    assert.strictEqual(again.red.cached, false, "a flaky verdict is never cached");
    assert.ok(has(again, flaky), why(again));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("#28 W07: a mutant run the runner doesn't finish (killed by a signal) gives no verdict, even with a report", () => {
  const forge = "const fs = require('fs'), path = require('path');\n" +
    "const f = path.resolve(__dirname, '../test/add.test.js');\n" +
    "fs.writeFileSync(path.resolve(__dirname, '../.catalina-red-report.json'), JSON.stringify({ testResults: [{ name: f, status: 'failed', message: '', assertionResults: [{ ancestorTitles: [], title: 'adds', status: 'failed', failureMessages: ['AssertionError'] }, { ancestorTitles: [], title: 'is a function', status: 'passed', failureMessages: [] }] }] }));\n" +
    "process.kill(process.ppid, 'SIGKILL');\n" + FIXED;
  const { repo, tip } = setup(362, { patches: (r) => ({ "evidence/m.patch": diffOf(r, ADD, forge) }) });
  const r = run(repo, 362, { sha: tip });
  assert.strictEqual(r.ok, false);
  assert.ok(has(r, /under mutant evidence\/m\.patch the test run was killed \(SIGKILL\): a run that doesn't finish gives no verdict/), why(r));
});

test("#28 W02, W02b: an old test moved or renamed into another file isn't changed", () => {
  for (const [n, file] of [[363, "test/more.test.js"], [364, "test/add.spec.js"]]) {
    const { repo, tip } = setup(n, { base: { [T]: OLD_W }, testText: OLD_W, extra: { [T]: null, [file]: OLD_W }, lines: [line({ tests: [`${file} > add > adds`] })] });
    const r = run(repo, n, { sha: tip });
    assert.strictEqual(r.ok, false, file);
    const esc = file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    assert.ok(has(r, new RegExp(`${esc} > add > adds isn't new or changed since the base \\([0-9a-f]{7}\\): test/add\\.test\\.js there has a test with the same body`)), `${file}: ${why(r)}`);
  }
});

test("#28 W03b: adding or dropping a semicolon in an old test isn't a change", () => {
  const bare = OLD_W.replace("assert.strictEqual(add(2, 3), 5);", "assert.strictEqual(add(2, 3), 5)");
  const { repo, tip } = setup(365, { base: { [T]: bare }, testText: OLD_W, lines: [line({ tests: [`${T} > add > adds`] })] });
  const r = run(repo, 365, { sha: tip });
  assert.strictEqual(r.ok, false);
  assert.ok(has(r, /test\/add\.test\.js > add > adds isn't new or changed since the base/), why(r));
});

test("#28 W09: a patch path under node_modules, ignored, or not tracked at the base is refused", () => {
  const mod = "diff --git a/node_modules/tiny/index.js b/node_modules/tiny/index.js\n--- a/node_modules/tiny/index.js\n+++ b/node_modules/tiny/index.js\n@@ -1 +1 @@\n-module.exports = (x) => x;\n+module.exports = (x) => (x === 5 ? 6 : x);\n";
  const gen = "diff --git a/src/gen.js b/src/gen.js\n--- a/src/gen.js\n+++ b/src/gen.js\n@@ -1 +1 @@\n-module.exports = 1;\n+module.exports = 2;\n";
  for (const [n, patch, re] of [
    [366, () => mod, /mutant evidence\/m\.patch touches node_modules\/tiny\/index\.js \(under node_modules\): a mutant changes code the base tracks/],
    [367, () => gen, /mutant evidence\/m\.patch touches src\/gen\.js \(ignored\)/],
    [368, (r) => newFile("src/extra.js") + MUTANT(r), /mutant evidence\/m\.patch touches src\/extra\.js \(not tracked at the base\)/],
  ]) {
    const { repo, tip } = setup(n, { base: { ".gitignore": "node_modules/\nsrc/gen.js\n" }, patches: (r) => ({ "evidence/m.patch": patch(r) }) });
    const r = run(repo, n, { sha: tip });
    assert.strictEqual(r.ok, false, `${n}`);
    assert.ok(has(r, re), `${n}: ${why(r)}`);
  }
});

test("#28 W10w: in worktree mode a patch under a symlinked directory is refused too", () => {
  const os = require("os");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "catalina-outside-"));
  try {
    const repo = makeRepo({ baseFixed: true, config: VITEST });
    const { tip, dir } = guardIssue(repo, 369);
    fs.writeFileSync(path.join(outside, "m.patch"), MUTANT(repo));
    fs.symlinkSync(outside, path.join(repo.cwd, dir, "ev2"));
    fs.appendFileSync(path.join(repo.cwd, dir, "verification.jsonl"), JSON.stringify(line({ patch: "ev2/m.patch" })) + "\n");
    const r = check(369, { cwd: repo.cwd, source: "worktree", red: "run", sha: tip });
    assert.strictEqual(r.ok, false);
    assert.ok(has(r, /mutant ev2\/m\.patch sits under a symlink \(\.claude\/tracking\/issue-369\/ev2\)/), why(r));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("#28 W08b: a templated title is a pattern of its static parts, so a sibling with another name is located", () => {
  const t = HEAD + "test.describe('add', () => {\n  for (const [a, b, s] of [[1, 1, 2], [2, 2, 4]]) test(`adds ${a} and ${b}`, () => assert.strictEqual(add(a, b), s));\n  test('adds big', () => assert.strictEqual(add(20, 30), 50));\n  test('is a function', () => assert.strictEqual(typeof add, 'function'));\n});\n";
  const big = (r) => ({ "evidence/m.patch": diffOf(r, ADD, "module.exports = (a, b) => (a > 10 ? a : a + b);\n") });
  const { repo, tip } = setup(370, { testText: t, patches: big, lines: [line({ tests: [`${T} > add > adds big`] })] });
  const r = run(repo, 370, { sha: tip });
  assert.deepStrictEqual(r.reasons, []);
});

test("#28 W05: src/setup.js is code, not a test setup file: a mutant may change it", () => {
  const setupJs = "module.exports = { base: 0 };\n";
  const code = "const { base } = require('./setup');\nmodule.exports = (a, b) => base + a + b;\n";
  const { repo, tip } = setup(371, {
    base: { "src/setup.js": setupJs, [ADD]: code },
    patches: (r) => ({ "evidence/m.patch": diffOf(r, "src/setup.js", "module.exports = { base: 1 };\n") }),
  });
  const r = run(repo, 371, { sha: tip });
  assert.deepStrictEqual(r.reasons, []);
});

test("#28 W05: the infrastructure list covers setup, global setup, mocks, fixtures, helpers and test utils by name", () => {
  const infra = infraMatcher({});
  for (const f of ["src/test-setup.ts", "jest-setup.js", "vitest-setup.ts", "src/global-setup.ts", "globalSetup.ts", "jest.globalSetup.js", "src/mocks/handlers.ts", "src/add.mock.ts", "src/add.mocks.ts", "src/user.fixtures.ts", "src/add.helpers.ts", "src/testUtils.ts", "src/test-helpers.ts", "src/testHelpers.ts", "setupTests.js", "src/vitest.setup.ts"]) {
    assert.ok(infra(f), `${f} is infrastructure`);
  }
  for (const f of ["src/setup.ts", "src/Setup.ts", "src/settings.ts", "src/add.js", "src/mockingbird.ts", "src/helpers.ts", "src/fixtures.ts"]) {
    assert.strictEqual(infra(f), null, `${f} is code`);
  }
});

test("#28 W06 list: runner reach covers the vitest worker, onTest hooks, import.meta.vitest and a runner global by string", () => {
  const P = (l) => `diff --git a/src/add.js b/src/add.js\n--- a/src/add.js\n+++ b/src/add.js\n@@ -1 +1,2 @@\n+${l}\n module.exports = (a, b) => a + b;\n`;
  for (const l of [
    'if (globalThis.__vitest_worker__?.current?.name?.includes("x")) throw new Error("x");',
    "onTestFailed(() => {});",
    "onTestFinished(() => {});",
    "if (import.meta.vitest) { const t = import.meta.vitest; }",
    'globalThis["expect"] = null;',
    "global['it'] = null;",
    'Object.defineProperty(globalThis, "expect", { value: 1 });',
    'globalThis["__vitest_worker__"] = 1;',
    'const { stub } = require("sinon");',
    'require("should");',
    'import "@testing-library/jest-dom";',
  ]) {
    assert.strictEqual(runnerReach(Buffer.from(P(l))).length, 1, l);
  }
  for (const l of ['globalThis["config"] = 1;', "const onTestable = x.onTestFailedCount;", 'const s = "import.meta.vitest";', "Object.defineProperty(globalThis, \"cache\", { value: 1 });"]) {
    assert.deepStrictEqual(runnerReach(Buffer.from(P(l))), [], l);
  }
});
