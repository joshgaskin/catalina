/**
 * #21: `catalina audit --shadow-report` read a log in one clone's git dir while pushes and merges ran from others, so it
 * said "0 would-blocks" about a gate it never heard from. Every gate run now goes to one box-wide log, and a report
 * with no log (or no run for commits that landed) is an error.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { makeRepo, buildIssue, gateRuns, sh, ROOT } = require("./helpers/repo");
const { audit } = require("../lib/audit");

const STUB = path.join(__dirname, "helpers", "gh-stub.js");
fs.chmodSync(STUB, 0o755);

/** A second clone of the fixture's remote with the real pre-push hook: another builder's worktree or the merge bot's clone. */
function otherClone(repo) {
  const dir = path.join(repo.tmp, "hooks");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "hooks", "pre-push"), path.join(dir, "pre-push"));
  fs.chmodSync(path.join(dir, "pre-push"), 0o755);
  const cwd = path.join(repo.tmp, "other");
  sh("git", ["clone", "-q", repo.bare, cwd], repo.tmp);
  sh("git", ["config", "core.hooksPath", dir], cwd);
  sh("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], cwd);
  const git = (...a) => sh("git", a, cwd).trim();
  return {
    cwd,
    git,
    write(rel, text) {
      fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), text);
    },
    push() {
      const r = spawnSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd, encoding: "utf8", env: { ...process.env, CATALINA_HOME: ROOT } });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    },
    commit(msg) {
      git("add", "-A");
      sh("git", ["commit", "-q", "-m", msg], cwd);
    },
  };
}

const report = (repo, o = {}) => audit({ cwd: repo.cwd, since: "72h", shadowReport: true, ...o });

test("#21 AC1: a would-block push from another clone shows up in --shadow-report from the main clone", () => {
  const repo = makeRepo({ config: { mode: "shadow" } });
  const other = otherClone(repo);
  other.write("payments/charge.js", "module.exports = 1;\n");
  other.commit("quick money");
  const push = other.push();
  assert.strictEqual(push.code, 0, push.out); // shadow never blocks
  const r = report(repo);
  assert.strictEqual(r.runs, 1);
  assert.strictEqual(r.wouldBlock, 1);
  assert.match(JSON.stringify(r.days), /payments\/charge\.js/);
  assert.strictEqual(r.days[0].items[0].kind, "push");
});

test("#21 AC2: a passing push is a gate run too, so a quiet report is told apart from a gate that never ran", () => {
  const repo = makeRepo({ config: { mode: "shadow" } });
  const other = otherClone(repo);
  other.write("docs/x.md", "x\n");
  other.commit("quick docs");
  assert.strictEqual(other.push().code, 0);
  const r = report(repo);
  assert.strictEqual(r.runs, 1);
  assert.strictEqual(r.wouldBlock, 0);
  assert.deepStrictEqual(gateRuns(repo).map((x) => x.ok), [true]);
});

test("#21 AC3: no gate log is an error, not 0 would-blocks (control)", () => {
  const repo = makeRepo({ config: { mode: "shadow" } });
  assert.throws(() => report(repo), /no gate log at .*gate\.log: no push or merge has run the gate/);
  const r = spawnSync("node", [path.join(ROOT, "bin", "catalina"), "audit", "--shadow-report"], { cwd: repo.cwd, encoding: "utf8", env: process.env });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stderr, /catalina audit failed: no gate log at/);
  const j = spawnSync("node", [path.join(ROOT, "bin", "catalina"), "audit", "--shadow-report", "--json"], { cwd: repo.cwd, encoding: "utf8", env: process.env });
  assert.strictEqual(j.status, 1);
});

test("#21 AC4: commits landed on main but the log has no run in the window is an error (control)", () => {
  const repo = makeRepo({ config: { mode: "shadow" } });
  // Land code on main without the hook (a merge button, a skipped hook), then log an old run so the file exists.
  repo.write("src/other.js", "module.exports = 2;\n");
  repo.commit("landed with no hook");
  repo.git("push", "-q", "origin", "HEAD:main");
  const log = path.join(repo.tmp, "state", "o__r", "gate.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, JSON.stringify({ at: new Date(Date.now() - 30 * 86400e3).toISOString(), host: "h", kind: "push", ok: true, reasons: [] }) + "\n");
  assert.throws(() => report(repo), /landed on origin\/main .* no gate run in that window/);
});

test("#21 AC5: a merge through catalina-gh is logged to the same file, passing or not", () => {
  const repo = makeRepo({ config: { mode: "shadow" } });
  const { tip } = buildIssue(repo, 301, { omit: ["dod"] });
  repo.git("push", "-q", "origin", "HEAD:refs/pull/7/head");
  const state = path.join(repo.tmp, "gh-state.json");
  fs.writeFileSync(state, JSON.stringify({ remote: repo.bare, prs: { 7: { number: 7, headRefOid: tip, baseRefName: "main" } } }));
  const r = spawnSync("node", [path.join(ROOT, "bin", "catalina-gh"), "pr", "merge", "7", "-R", "o/r"], {
    cwd: repo.tmp,
    encoding: "utf8",
    env: { ...process.env, CATALINA_REAL_GH: STUB, CATALINA_GH_STATE: state, CATALINA_GATE_DIR: path.join(repo.tmp, "gate") },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const x = report(repo);
  assert.strictEqual(x.runs, 1);
  assert.strictEqual(x.wouldBlock, 1);
  assert.strictEqual(x.days[0].items[0].kind, "merge");
});
