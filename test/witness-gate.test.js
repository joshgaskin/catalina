const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawnSync } = require("child_process");
const { makeRepo, buildIssue } = require("./helpers/repo");
const { check } = require("../lib/check");

const HOOK = path.join(__dirname, "..", "hooks", "witness-gate.js");
const flip = (repo, n) => {
  const started = Date.now();
  const r = spawnSync("node", [HOOK], { cwd: repo.cwd, encoding: "utf8", input: JSON.stringify({ tool_input: { command: `gh issue edit ${n} --remove-label dev/implement --add-label review` } }) });
  return { code: r.status, err: r.stderr, ms: Date.now() - started };
};

test("AC12: the gate blocks a flip with a missing premortem line", () => {
  const repo = makeRepo();
  buildIssue(repo, 150, { omit: ["pmline"] });
  const r = flip(repo, 150);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /P1 has no verification/);
});

test("AC12: on a cache hit the gate passes in under 10 s; it never runs the red tests itself", () => {
  const repo = makeRepo();
  buildIssue(repo, 151);
  const cold = flip(repo, 151);
  assert.strictEqual(cold.code, 2, "no red proof cached yet");
  assert.match(cold.err, /red proof not run yet/);
  assert.strictEqual(check(151, { cwd: repo.cwd, source: "worktree", red: "run", witness: true }).ok, true);
  const warm = flip(repo, 151);
  assert.strictEqual(warm.code, 0, warm.err);
  assert.ok(warm.ms < 10000, `${warm.ms} ms`);
});
