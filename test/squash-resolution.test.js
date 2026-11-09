/**
 * #20: a squash merge (or rebase) of a witnessed branch, after main moved under it, carries the witnessed change
 * plus whatever a person did to resolve conflicts. A resolution in a file that is neither code nor tests
 * (RELEASE_NOTES.md) doesn't make the witness stale; a hand-edited code or test file does.
 *
 * Real shapes, 8 Nov 2026 replay of plus2's merges: #2169 and #2356 (RELEASE_NOTES.md bullets reworded in the
 * conflict), #2180 (a one-line adaptation in api.ts to a type another PR had changed).
 */
const test = require("node:test");
const assert = require("node:assert");
const { makeRepo, tracking, verification, FIXED, TEST } = require("./helpers/repo");
const { check } = require("../lib/check");

const has = (r, re) => r.reasons.some((x) => re.test(x));

/**
 * Issue n on branch issue-n (fix + RELEASE_NOTES entry, then evidence naming the fix). Main then moves with a
 * conflicting change to the same lines. The branch is squash-merged, `resolve` writing the resolved files.
 */
function squashedOverConflict(repo, n, resolve, { mainAdd = "module.exports = (a, b) => a * b;\n" } = {}) {
  repo.write("RELEASE_NOTES.md", "# Notes\n\n- old entry\n");
  repo.commit("notes");
  repo.git("push", "-q", "origin", "HEAD:main");
  repo.git("checkout", "-q", "-b", `issue-${n}`, "origin/main");
  repo.write("src/add.js", FIXED);
  repo.write("test/add.test.js", TEST);
  repo.write("RELEASE_NOTES.md", "# Notes\n\n- *Add*: add now adds\n- old entry\n");
  const witnessed = repo.commit(`fix add (Refs #${n})`);
  repo.write(`.claude/tracking/issue-${n}/tracking.md`, tracking(n));
  repo.write(`.claude/tracking/issue-${n}/verification.jsonl`, verification(witnessed));
  repo.commit(`evidence (Refs #${n})`);
  repo.git("checkout", "-q", "main");
  repo.write("RELEASE_NOTES.md", "# Notes\n\n- *Other*: something else\n- old entry\n");
  repo.write("src/add.js", mainAdd);
  repo.commit("another change to the same lines");
  repo.git("push", "-q", "origin", "HEAD:main");
  try {
    repo.git("merge", "--squash", `issue-${n}`);
  } catch {} // the conflict: resolved below
  resolve(repo);
  const squash = repo.commit(`fix add (#9)\n\nRefs #${n}`);
  repo.git("push", "-q", "origin", "HEAD:main");
  return { witnessed, squash };
}

const run = (repo, n, sha, o = {}) => check(n, { cwd: repo.cwd, source: "commit", red: "run", sha, ...o });

test("#20 AC1: a squash whose RELEASE_NOTES.md conflict was resolved by hand keeps the witness (the #2169 shape)", () => {
  const repo = makeRepo();
  const { squash } = squashedOverConflict(repo, 400, (r) => {
    r.write("RELEASE_NOTES.md", "# Notes\n\n• *Other*: something else\n• *Add*: add now adds (reworded)\n- old entry\n");
    r.write("src/add.js", FIXED); // main's change to the same line is dropped in favour of the fix: the witnessed version
  });
  const r = run(repo, 400, squash);
  assert.deepStrictEqual(r.reasons, []);
});

test("#20 AC2: a code file resolved to something no witness saw still fails, naming it (control)", () => {
  const repo = makeRepo();
  const { squash } = squashedOverConflict(repo, 401, (r) => {
    r.write("RELEASE_NOTES.md", "# Notes\n\n- *Other*: something else\n- *Add*: add now adds\n- old entry\n");
    r.write("src/add.js", "module.exports = (a, b) => a + b + 0;\n");
  });
  const r = run(repo, 401, squash);
  assert.ok(has(r, /witnessed sha .* is not in the history of .*different change in src\/add\.js/), JSON.stringify(r.reasons));
});

test("#20 AC3: a squash that also carries code written after the witness still fails (control)", () => {
  const repo = makeRepo();
  const { squash } = squashedOverConflict(repo, 402, (r) => {
    r.write("RELEASE_NOTES.md", "# Notes\n\n- *Other*: something else\n- *Add*: add now adds\n- old entry\n");
    r.write("src/add.js", FIXED);
    r.write("src/extra.js", "module.exports = 1;\n");
  });
  const r = run(repo, 402, squash);
  assert.ok(has(r, /not in the history/), JSON.stringify(r.reasons));
  assert.ok(has(r, /src\/extra\.js/), JSON.stringify(r.reasons));
});

test("#20 AC4: a test file resolved by hand still fails (tests are what the witness ran)", () => {
  const repo = makeRepo();
  const { squash } = squashedOverConflict(repo, 403, (r) => {
    r.write("RELEASE_NOTES.md", "# Notes\n\n- *Other*: something else\n- *Add*: add now adds\n- old entry\n");
    r.write("src/add.js", FIXED);
    r.write("test/add.test.js", TEST.replace("5)", "5) // loosened"));
  });
  const r = run(repo, 403, squash);
  assert.ok(has(r, /test\/add\.test\.js/), JSON.stringify(r.reasons));
});
