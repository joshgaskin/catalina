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

// #27: the gate checks the repo gh edits, not the session cwd.
const fs = require("fs");
const os = require("os");
const FLIP = "--remove-label dev/implement --add-label review";
const gate = (cwd, command, env = {}, hook = HOOK) => {
  const base = { ...process.env };
  delete base.CATALINA_WITNESS_ALLOW;
  const r = spawnSync("node", [hook], { cwd, encoding: "utf8", env: { ...base, ...env }, input: JSON.stringify({ tool_input: { command } }) });
  return { code: r.status, err: r.stderr };
};

/**
 * A session repo (plus2's place) and a target repo (Hatchery's), both with issue n. "pass" is complete with its red
 * proof cached; "fail" is missing its premortem line; "none" has no tracking dir. The target is reachable as the
 * sibling `<session parent>/target` and has a remote named for o/target.
 */
function twoRepos(n, { session, target }) {
  const build = (repo, kind) => {
    if (kind === "none") return;
    buildIssue(repo, n, kind === "fail" ? { omit: ["pmline"] } : {});
    if (kind === "pass") assert.strictEqual(check(n, { cwd: repo.cwd, source: "worktree", red: "run", witness: true }).ok, true);
  };
  const t = makeRepo();
  build(t, target);
  t.git("remote", "add", "gh", "https://github.com/o/target.git");
  const s = makeRepo();
  build(s, session);
  s.git("remote", "add", "gh", "git@github.com:o/session.git");
  fs.symlinkSync(t.cwd, path.join(s.tmp, "target"));
  return { s, t };
}

test("#27 AC1: `cd <repo> &&` checks that repo's issue, not the session's", () => {
  const a = twoRepos(160, { session: "fail", target: "pass" });
  const ok = gate(a.s.cwd, `cd ${a.t.cwd} && gh issue edit 160 ${FLIP}`);
  assert.strictEqual(ok.code, 0, ok.err);
  for (const c of [`(cd ../target && gh issue edit 160 ${FLIP})`, `cd ~/target; gh issue edit 160 ${FLIP}`]) {
    const r = gate(a.s.cwd, c, { HOME: a.s.tmp });
    assert.strictEqual(r.code, 0, `${c}: ${r.err}`);
  }
  const quoted = gate(a.s.cwd, `git commit -m "cd ${a.t.cwd} && x" && gh issue edit 160 ${FLIP}`);
  assert.strictEqual(quoted.code, 2, "a quoted cd doesn't move the gate");

  const b = twoRepos(161, { session: "none", target: "fail" });
  const r = gate(b.s.cwd, `cd ${b.t.cwd} && gh issue edit 161 ${FLIP}`);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /P1 has no verification/);
  assert.ok(r.err.includes(fs.realpathSync(b.t.cwd)), `names the repo: ${r.err}`);
});

test("#27 AC2: -R/--repo and an issue URL check a local checkout of that repo", () => {
  const a = twoRepos(162, { session: "none", target: "fail" });
  for (const c of [
    `gh -R o/target issue edit 162 ${FLIP}`,
    `gh issue edit 162 --repo o/target ${FLIP}`,
    `gh issue edit 162 --repo=o/target ${FLIP}`,
    `gh issue edit https://github.com/o/target/issues/162 ${FLIP}`,
  ]) {
    const r = gate(a.s.cwd, c);
    assert.strictEqual(r.code, 2, c);
    assert.match(r.err, /P1 has no verification/, c);
  }
  const b = twoRepos(163, { session: "fail", target: "pass" });
  const ok = gate(b.s.cwd, `gh -R o/target issue edit 163 ${FLIP}`);
  assert.strictEqual(ok.code, 0, ok.err);
  const own = gate(b.s.cwd, `gh -R o/session issue edit 163 ${FLIP}`);
  assert.strictEqual(own.code, 2, "the session repo itself, named");
});

test("#27 AC2: a named repo with no local checkout is let through, and says so", () => {
  const a = twoRepos(164, { session: "fail", target: "fail" });
  const r = gate(a.s.cwd, `gh -R o/nowhere issue edit 164 ${FLIP}`);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.err, /issue 164 in o\/nowhere NOT checked/);
});

test("#27 AC3: CATALINA_WITNESS_ALLOW=1 works as a command prefix", () => {
  const a = twoRepos(165, { session: "fail", target: "none" });
  for (const c of [
    `CATALINA_WITNESS_ALLOW=1 gh issue edit 165 ${FLIP}`,
    `env CATALINA_WITNESS_ALLOW=1 gh issue edit 165 ${FLIP}`,
    `export CATALINA_WITNESS_ALLOW=1 && gh issue edit 165 ${FLIP}`,
  ]) {
    const r = gate(a.s.cwd, c);
    assert.strictEqual(r.code, 0, c);
    assert.match(r.err, /BYPASSED/, c);
  }
  for (const c of [`CATALINA_WITNESS_ALLOW=0 gh issue edit 165 ${FLIP}`, `CATALINA_WITNESS_ALLOW=1 true && gh issue edit 165 ${FLIP}`]) {
    assert.strictEqual(gate(a.s.cwd, c).code, 2, c);
  }
});

test("#27 AC4: git -C doesn't move the gate (gh doesn't read it), and a different repo is noted", () => {
  const a = twoRepos(166, { session: "fail", target: "pass" });
  const r = gate(a.s.cwd, `git -C ${a.t.cwd} log -1 && gh issue edit 166 ${FLIP}`);
  assert.strictEqual(r.code, 2, "gh edits the session repo's #166, so that is what is checked");
  assert.match(r.err, /git -C/);
});

test("#27 AC5: several numbers are each gated; messages name a repo that isn't the cwd", () => {
  const repo = makeRepo();
  buildIssue(repo, 171, { omit: ["pmline"] }); // 170 has no tracking dir: not an ILR issue, so only 171 can block
  const r = gate(repo.cwd, `gh issue edit 170 171 ${FLIP}`);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /issue 171/);
});

test("#27 AC5: the hook finds its parsing module when installed as per-file links", () => {
  const a = twoRepos(172, { session: "fail", target: "pass" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalina-hooks-"));
  fs.mkdirSync(path.join(dir, "lib"));
  fs.symlinkSync(HOOK, path.join(dir, "witness-gate.js"));
  fs.symlinkSync(path.join(path.dirname(HOOK), "lib", "verify-witness.js"), path.join(dir, "lib", "verify-witness.js"));
  const r = gate(a.s.cwd, `cd ${a.t.cwd} && gh issue edit 172 ${FLIP}`, {}, path.join(dir, "witness-gate.js"));
  assert.strictEqual(r.code, 0, r.err);
});
