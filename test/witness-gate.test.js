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
  const r = spawnSync("node", [hook], { cwd, encoding: "utf8", env: { ...base, ...env }, input: JSON.stringify({ tool_input: { command } }), timeout: 20000 });
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

test("#27 AC1: a cd never moves the gate: the session repo is always checked, and the cd's repo too", () => {
  const a = twoRepos(160, { session: "fail", target: "pass" });
  for (const c of [`cd ${a.t.cwd} && gh issue edit 160 ${FLIP}`, `(cd ../target && gh issue edit 160 ${FLIP})`, `cd ~/target; gh issue edit 160 ${FLIP}`]) {
    const r = gate(a.s.cwd, c, { HOME: a.s.tmp });
    assert.strictEqual(r.code, 2, `${c}: ${r.err}`);
    assert.match(r.err, /P1 has no verification/, c);
    assert.match(r.err, /to flip an issue in another repo, run `gh issue edit N -R owner\/name/, c);
  }
  const b = twoRepos(161, { session: "pass", target: "fail" });
  const r = gate(b.s.cwd, `cd ${b.t.cwd} && gh issue edit 161 ${FLIP}`);
  assert.strictEqual(r.code, 2, "the cd's repo fails, so it blocks");
  assert.ok(r.err.includes(fs.realpathSync(b.t.cwd)), `names the repo: ${r.err}`);
  const c = twoRepos(159, { session: "pass", target: "pass" });
  const ok = gate(c.s.cwd, `cd ${c.t.cwd} && gh issue edit 159 ${FLIP}`);
  assert.strictEqual(ok.code, 0, ok.err);
  assert.match(ok.err, /every repo this command could reach/);
});

test("#27 AC2: a flip that names its repo (-R/--repo, an issue URL) is checked there only", () => {
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
  for (const c of [
    `gh -R o/target issue edit 163 ${FLIP}`,
    `cd ${b.s.cwd} && gh -R o/target issue edit 163 ${FLIP}`,
    `gh issue edit https://github.com/o/target/issues/163 -R o/session ${FLIP}`,
  ]) {
    const ok = gate(b.s.cwd, c);
    assert.strictEqual(ok.code, 0, `${c}: ${ok.err}`);
  }
  assert.strictEqual(gate(b.s.cwd, `gh -R o/session issue edit 163 ${FLIP}`).code, 2, "the session repo itself, named");
  assert.strictEqual(gate(b.s.cwd, `gh issue edit https://github.com/o/session/issues/163 -R o/target ${FLIP}`).code, 2, "the URL wins over -R");
  for (const c of [`gh -R "$R" issue edit 163 ${FLIP}`, `gh -R o/target issue edit 163 ${FLIP} 2>&1`, `GH_REPO=o/target gh -R o/target issue edit 163 ${FLIP}`]) {
    assert.strictEqual(gate(b.s.cwd, c, { R: "o/target" }).code, 2, `not clean, so the union: ${c}`);
  }
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
  assert.doesNotMatch(gate(a.s.cwd, `git -C . status && gh issue edit 166 ${FLIP}`).err, /note: .*git -C/);
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
  const r = gate(a.s.cwd, `gh -R o/target issue edit 172 ${FLIP}`, {}, path.join(dir, "witness-gate.js"));
  assert.strictEqual(r.code, 0, r.err);
});

test("#27 witness fixes 1-2: a cd the gate can't read still checks the session repo", () => {
  const a = twoRepos(173, { session: "fail", target: "pass" });
  for (const c of [
    `WT=${a.t.cwd}; cd $WT && gh issue edit 173 ${FLIP}`,
    `cd $(git rev-parse --show-toplevel) && gh issue edit 173 ${FLIP}`,
    `cd /no/such/dir; gh issue edit 173 ${FLIP}`,
    `(cd ../target && git status -s) && gh issue edit 173 ${FLIP}`,
    `X=$(cd ../target && pwd) && gh issue edit 173 ${FLIP}`,
  ]) {
    const r = gate(a.s.cwd, c);
    assert.strictEqual(r.code, 2, `${c}: ${r.err}`);
    assert.match(r.err, /P1 has no verification/, c);
  }
});

test("#27 witness fix 3: wrapped gh is gated, and anything the old regex caught but the parser can't read gates the cwd", () => {
  const a = twoRepos(174, { session: "fail", target: "none" });
  const gh = spawnSync("sh", ["-c", "command -v gh || echo /opt/homebrew/bin/gh"], { encoding: "utf8" }).stdout.trim();
  for (const c of [
    `${gh} issue edit 174 ${FLIP}`,
    `timeout 60 gh issue edit 174 ${FLIP}`,
    `command gh issue edit 174 ${FLIP}`,
    `env -u FOO gh issue edit 174 ${FLIP}`,
    `echo 174 | xargs -I{} gh issue edit {} ${FLIP}`,
    `echo "gh issue edit 174 ${FLIP}"`,
  ]) assert.strictEqual(gate(a.s.cwd, c).code, 2, c);
  assert.match(gate(a.s.cwd, `echo "gh issue edit 174 ${FLIP}"`).err, /every repo this command could reach/);
});

test("#27 witness fix 5 and third witness D3: GH_REPO in any form checks its repo and the session's", () => {
  const a = twoRepos(176, { session: "none", target: "fail" });
  const b = twoRepos(175, { session: "fail", target: "pass" });
  for (const [c, env] of [
    [`GH_REPO=o/target gh issue edit N ${FLIP}`, {}],
    [`export GH_REPO=o/target; gh issue edit N ${FLIP}`, {}],
    [`GH_REPO=o/target; export GH_REPO; gh issue edit N ${FLIP}`, {}],
    [`declare -x GH_REPO=o/target; gh issue edit N ${FLIP}`, {}],
    [`set -a; GH_REPO=o/target; gh issue edit N ${FLIP}`, {}],
    [`gh issue edit N ${FLIP}`, { GH_REPO: "o/target" }],
  ]) {
    const r = gate(a.s.cwd, c.replace("N", "176"), env);
    assert.strictEqual(r.code, 2, `${c} ${JSON.stringify(env)}: ${r.err}`);
    assert.match(r.err, /P1 has no verification/);
    assert.strictEqual(gate(b.s.cwd, c.replace("N", "175"), env).code, 2, `the session repo too: ${c}`);
  }
});

test("#27 second witness: a script with a cd or a GH_REPO is checked in the session repo and every repo it names", () => {
  const a = twoRepos(177, { session: "fail", target: "pass" });
  for (const c of [
    `cat > /dev/null <<'X'\ncd ${a.t.cwd}\nX\ngh issue edit 177 ${FLIP}`,
    `false && cd ${a.t.cwd}; gh issue edit 177 ${FLIP}`,
    `f(){ cd ${a.t.cwd}; }; gh issue edit 177 ${FLIP}`,
    `cd ${a.t.cwd} | cat; gh issue edit 177 ${FLIP}`,
  ]) {
    const r = gate(a.s.cwd, c);
    assert.strictEqual(r.code, 2, `${c}: ${r.err}`);
    assert.match(r.err, /P1 has no verification/, c);
    assert.strictEqual(r.err.match(/every repo this command could reach/g).length, 1, c);
  }
  const b = twoRepos(178, { session: "pass", target: "fail" });
  const r = gate(b.s.cwd, `cd ${b.t.cwd} || true; gh issue edit 178 ${FLIP}`);
  assert.strictEqual(r.code, 2, "the target it might reach fails, so it blocks");
  assert.ok(r.err.includes(fs.realpathSync(b.t.cwd)), r.err);
});

test("#27 second witness: the bypass on a complex script is ignored, and says so", () => {
  const a = twoRepos(179, { session: "fail", target: "none" });
  for (const c of [
    `f(){ export CATALINA_WITNESS_ALLOW=1; }; gh issue edit 179 ${FLIP}`,
    `false && export CATALINA_WITNESS_ALLOW=1; gh issue edit 179 ${FLIP}`,
    `true # ; export CATALINA_WITNESS_ALLOW=1\ngh issue edit 179 ${FLIP}`,
  ]) assert.strictEqual(gate(a.s.cwd, c).code, 2, c);
  const r = gate(a.s.cwd, `true || true; CATALINA_WITNESS_ALLOW=1 gh issue edit 179 ${FLIP}`);
  assert.strictEqual(r.code, 2, r.err);
  assert.match(r.err, /CATALINA_WITNESS_ALLOW=1 on this command is ignored/);
  assert.strictEqual(gate(a.s.cwd, `gh issue edit 179 ${FLIP}`, { CATALINA_WITNESS_ALLOW: "1" }).code, 0, "the hook's own env still bypasses");
});

test("#27 second witness: an unreadable flip beside a readable one is still checked", () => {
  const a = twoRepos(180, { session: "fail", target: "none" });
  for (const c of [
    `env -S 'gh issue edit 180 ${FLIP}' && gh issue edit 99999 ${FLIP}`,
    `if true; then gh issue edit 180 ${FLIP}; fi; gh issue edit 99999 ${FLIP}`,
    `sudo -u gh gh issue edit 180 ${FLIP}; gh issue edit 99999 ${FLIP}`,
  ]) assert.strictEqual(gate(a.s.cwd, c).code, 2, c);
});

test("#27 second witness: -R in ssh or https URL form finds the checkout", () => {
  const a = twoRepos(181, { session: "pass", target: "fail" });
  for (const v of ["git@github.com:o/target.git", "https://github.com/o/target.git", "github.com/o/target"]) {
    const r = gate(a.s.cwd, `gh issue edit 181 ${FLIP} -R ${v}`);
    assert.strictEqual(r.code, 2, `${v}: ${r.err}`);
    assert.doesNotMatch(r.err, /NOT checked/, v);
  }
});

const GATE_ERROR = /catalina gate error, blocking: /;

test("#27 AC12: the gate fails closed: a deadline, a crash or input it can't read blocks a review flip", () => {
  const a = twoRepos(182, { session: "pass", target: "none" });
  assert.strictEqual(gate(a.s.cwd, `gh issue edit 182 ${FLIP}`).code, 0, "passes normally");
  const slow = gate(a.s.cwd, `gh issue edit 182 ${FLIP}`, { CATALINA_GATE_DEADLINE_MS: "1" });
  assert.strictEqual(slow.code, 2, slow.err);
  assert.match(slow.err, GATE_ERROR);
  assert.match(slow.err, /deadline/);

  // verification.jsonl as a directory: the validator throws EISDIR.
  const b = twoRepos(183, { session: "none", target: "none" });
  fs.mkdirSync(path.join(b.s.cwd, ".claude", "tracking", "issue-183", "verification.jsonl"), { recursive: true });
  fs.writeFileSync(path.join(b.s.cwd, ".claude", "tracking", "issue-183", "tracking.md"), "# x\n");
  b.s.git("commit", "--allow-empty", "-m", "touch (Refs #183)"); // so the check reaches the evidence read
  const eisdir = gate(b.s.cwd, `gh issue edit 183 ${FLIP}`);
  assert.strictEqual(eisdir.code, 2, eisdir.err);
  assert.match(eisdir.err, GATE_ERROR);

  const raw = (input) => spawnSync("node", [HOOK], { cwd: a.s.cwd, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 }).status;
  assert.strictEqual(raw(`{"tool_input": {"command": "gh issue edit 182 --add-label review"`), 2, "broken JSON that mentions review");
  assert.strictEqual(raw(`{"tool_input": {"command": "ls"`), 0, "broken JSON that doesn't");
  const big = JSON.stringify({ tool_input: { command: `gh issue edit 182 ${FLIP} # ${"x".repeat(1100 * 1024)}` } });
  assert.strictEqual(raw(big), 2, "over 1 MB, mentioning review");
  assert.strictEqual(raw(JSON.stringify({ tool_input: { command: `ls # ${"x".repeat(1100 * 1024)}` } })), 0, "over 1 MB, not");
  assert.strictEqual(raw(JSON.stringify({ tool_input: { command: "ls" } })), 0);
});

test("#27 AC12: a command built to make the gate slow (the witness's dos.js, K=200) blocks within 6 s", () => {
  const P = path.join(os.tmpdir());
  const fw = fs.existsSync("/System/Library/Frameworks")
    ? fs.readdirSync("/System/Library/Frameworks").map((d) => "/System/Library/Frameworks/" + d)
    : Array.from({ length: 340 }, (_, i) => `/usr/lib/x${i}`);
  const slugs = Array.from({ length: 200 }, (_, i) => `-R n/x${i}`).join(" ");
  const bases = ["Versions", "Versions/A", "Versions/Current", "Resources", "Versions/A/Resources"];
  for (const command of [
    "true # " + fw.map((d) => "cd " + d).join(" ") + " " + slugs + "\ngh issue edit 138 --add-label review",
    "true # " + [...fw.map((d) => "cd " + d), ...bases.map((r) => "cd " + r)].join(" ") + "\ngh issue edit 138 --add-label review",
  ]) {
    const t = Date.now();
    const r = gate(P, command);
    const ms = Date.now() - t;
    assert.strictEqual(r.code, 2, r.err);
    assert.ok(ms < 6000, `${ms} ms`);
  }
});

test("#27 fourth witness: a flip the gate can't read blocks with one plain hint", () => {
  const a = twoRepos(190, { session: "pass", target: "pass" });
  const r = gate(a.s.cwd, `gh issue -R o/target edit 190 ${FLIP}`);
  assert.strictEqual(r.code, 2, r.err);
  assert.ok(r.err.includes("catalina gate: can't read this flip; write it as `gh issue edit N -R owner/name --add-label review`"), r.err);
  assert.strictEqual(r.err.split("catalina gate: can't read this flip").length, 2, `the hint prints once: ${r.err}`);
  const ok = gate(a.s.cwd, `gh issue edit 190 -R o/target ${FLIP}`);
  assert.strictEqual(ok.code, 0, ok.err);
});

test("#27 fourth witness: a label the shell builds, or one in gh's CSV quotes, is still a flip the hook sees", () => {
  const a = twoRepos(191, { session: "pass", target: "fail" });
  const built = gate(a.s.cwd, "gh issue edit 191 -R o/target --add-label rev${x}iew");
  assert.strictEqual(built.code, 2, built.err);
  assert.match(built.err, /can't read this flip/);
  const csv = gate(a.s.cwd, `gh issue edit 191 -R o/target --add-label '"review"'`);
  assert.strictEqual(csv.code, 2, csv.err);
  assert.match(csv.err, /P1 has no verification/);
});
