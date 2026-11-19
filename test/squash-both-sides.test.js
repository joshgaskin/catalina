/**
 * #31: a squash (or rebase) whose conflict in a code or test file was resolved by keeping both sides, as when two PRs
 * add cases next to each other, carries no code beyond the witnessed change and main's. It keeps the witness like a
 * clean merge (#20); a resolution that adds, drops or edits a line still fails.
 *
 * Real shapes, 16 Nov 2026 replay of plus2's merges: plus2#2561 (#2557 #2558 #2559: suite-cases.test.ts, both sides'
 * cases kept, main's first) and 88268a0 (#2490: suite/cases.ts, both imports kept, the witnessed one first).
 */
const test = require("node:test");
const assert = require("node:assert");
const { makeRepo, tracking, verification, FIXED } = require("./helpers/repo");
const { check, keptBoth } = require("../lib/check");

const has = (r, re) => r.reasons.some((x) => re.test(x));

const HEAD = "const test = require('node:test');\nconst assert = require('node:assert');\nconst add = require('../src/add');\n";
const MINE = "test('adds', () => assert.strictEqual(add(2, 3), 5));\n";
const THEIRS = "test('zero', () => assert.strictEqual(0, 0));\n";

/**
 * Issue n puts its test where test/add.test.js says "more tests here"; main puts another test there. Both replace the
 * same line, so the squash conflicts (and its diff isn't the witnessed one: the line is already gone), and `resolve`
 * writes the file.
 */
function squashedOverAdjacentAdds(repo, n, resolve) {
  repo.write("test/add.test.js", HEAD + "// more tests here\n");
  repo.commit("test file");
  repo.git("push", "-q", "origin", "HEAD:main");
  repo.git("checkout", "-q", "-b", `issue-${n}`, "origin/main");
  repo.write("src/add.js", FIXED);
  repo.write("test/add.test.js", HEAD + MINE);
  const witnessed = repo.commit(`fix add (Refs #${n})`);
  repo.write(`.claude/tracking/issue-${n}/tracking.md`, tracking(n));
  repo.write(`.claude/tracking/issue-${n}/verification.jsonl`, verification(witnessed));
  repo.commit(`evidence (Refs #${n})`);
  repo.git("checkout", "-q", "main");
  repo.write("test/add.test.js", HEAD + THEIRS);
  repo.commit("another test at the same place");
  repo.git("push", "-q", "origin", "HEAD:main");
  try {
    repo.git("merge", "--squash", `issue-${n}`);
  } catch {} // the conflict: resolved below
  resolve(repo);
  const squash = repo.commit(`fix add (#9)\n\nRefs #${n}`);
  repo.git("push", "-q", "origin", "HEAD:main");
  return { witnessed, squash };
}

const run = (repo, n, sha) => check(n, { cwd: repo.cwd, source: "commit", red: "run", sha });

test("#31 AC1: both sides kept, main's first, keeps the witness (the plus2#2561 shape)", () => {
  const repo = makeRepo();
  const { squash } = squashedOverAdjacentAdds(repo, 500, (r) => r.write("test/add.test.js", HEAD + THEIRS + MINE));
  assert.deepStrictEqual(run(repo, 500, squash).reasons, []);
});

test("#31 AC2: both sides kept, the witnessed side first, keeps the witness (the #2490 shape)", () => {
  const repo = makeRepo();
  const { squash } = squashedOverAdjacentAdds(repo, 501, (r) => r.write("test/add.test.js", HEAD + MINE + THEIRS));
  assert.deepStrictEqual(run(repo, 501, squash).reasons, []);
});

test("#31 AC3: both sides kept plus a line no witness saw still fails, naming the file (control)", () => {
  const repo = makeRepo();
  const { squash } = squashedOverAdjacentAdds(repo, 502, (r) => r.write("test/add.test.js", HEAD + THEIRS + MINE + "test('extra', () => {});\n"));
  const r = run(repo, 502, squash);
  assert.ok(has(r, /witnessed sha .* is not in the history of .*different change in test\/add\.test\.js/), JSON.stringify(r.reasons));
});

test("#31 AC4: main's side alone (the witnessed test dropped) still fails (control)", () => {
  const repo = makeRepo();
  const { squash } = squashedOverAdjacentAdds(repo, 503, (r) => r.write("test/add.test.js", HEAD + THEIRS));
  const r = run(repo, 503, squash);
  assert.ok(has(r, /not in the history/), JSON.stringify(r.reasons));
});

test("#31 keptBoth: each hunk in either order, the rest unchanged; an edit, a dropped side or an empty side is not both", () => {
  const c = "a\n<<<<<<< x\nb\n=======\nc\n>>>>>>> y\nd\n<<<<<<< x\ne\n||||||| base\nq\n=======\nf\n>>>>>>> y\n";
  assert.strictEqual(keptBoth(c, "a\nb\nc\nd\nf\ne\n"), true);
  assert.strictEqual(keptBoth(c, "a\nc\nb\nd\ne\nf\n"), true);
  assert.strictEqual(keptBoth(c, "a\nb\nc\nd\ne\n"), false); // a side dropped
  assert.strictEqual(keptBoth(c, "a\nb\nc\nD\ne\nf\n"), false); // a line outside the hunks edited
  assert.strictEqual(keptBoth(c, "a\nb\nc\nd\ne\nf\nz\n"), false); // a line added
  assert.strictEqual(keptBoth("a\n<<<<<<< x\n=======\nc\n>>>>>>> y\n", "a\nc\n"), false); // one side deleted: a choice, not both
  assert.strictEqual(keptBoth("a\nb\n", "a\nb\n"), false); // no conflict to resolve
  assert.strictEqual(keptBoth(null, "a\n"), false);
});
