const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { makeRepo, buildIssue, sh, ROOT } = require("./helpers/repo");

/** Wire the real hooks/pre-push into a fixture repo, pointing at this checkout. */
function hooked(opts) {
  const repo = makeRepo(opts);
  const dir = path.join(repo.tmp, "hooks");
  fs.mkdirSync(dir);
  fs.copyFileSync(path.join(ROOT, "hooks", "pre-push"), path.join(dir, "pre-push"));
  fs.chmodSync(path.join(dir, "pre-push"), 0o755);
  repo.git("config", "core.hooksPath", dir);
  repo.push = (...args) => {
    const r = spawnSync("git", ["push", "-q", "origin", ...args], { cwd: repo.cwd, encoding: "utf8", env: { ...process.env, CATALINA_HOME: ROOT } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return repo;
}

const shadowLog = (repo) => {
  const p = path.join(repo.cwd, ".git", "catalina", "shadow.log");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
};

test("AC5: a failing enforced issue is refused with its reasons", () => {
  const repo = hooked();
  buildIssue(repo, 101, { omit: ["dod"] });
  const r = repo.push("HEAD:main");
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /#101: no Definition of Done/);
});

test("AC5: a passing issue is allowed", () => {
  const repo = hooked();
  buildIssue(repo, 102);
  const r = repo.push("HEAD:main");
  assert.strictEqual(r.code, 0, r.out);
});

test("AC5: a legacy issue (below enforce_from) is checked as quick", () => {
  const repo = hooked();
  repo.write("src/other.js", "module.exports = 2;\n");
  repo.commit("tweak (Refs #12)");
  assert.strictEqual(repo.push("HEAD:main").code, 0);
});

test("AC5: a quick commit touching a no_undo path is refused, naming the file; elsewhere it's allowed", () => {
  const repo = hooked();
  repo.write("payments/charge.js", "module.exports = 1;\n");
  repo.commit("quick fix");
  const bad = repo.push("HEAD:main");
  assert.strictEqual(bad.code, 1);
  assert.match(bad.out, /payments\/charge\.js/);
  repo.git("reset", "-q", "--soft", "HEAD~1");
  repo.git("reset", "-q");
  repo.rm("payments/charge.js");
  repo.write("docs/x.md", "x\n");
  repo.commit("quick docs");
  assert.strictEqual(repo.push("HEAD:main").code, 0);
});

test("AC5: other branches are never blocked; new-branch pushes and deletes are handled", () => {
  const repo = hooked();
  buildIssue(repo, 103, { omit: ["dod"] });
  assert.strictEqual(repo.push("issue-103").code, 0);
  assert.strictEqual(repo.push("--delete", "issue-103").code, 0);
});

test("AC5: a branch can't put its own gate into shadow", () => {
  const repo = hooked();
  repo.write(".catalina/config.json", JSON.stringify(repo.config({ mode: "shadow" })));
  repo.write("payments/charge.js", "module.exports = 1;\n");
  repo.commit("quiet the gate");
  const r = repo.push("HEAD:main");
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /\.catalina\/config\.json/);
});

test("AC5: shadow mode allows everything and logs to the shared git-common-dir log", () => {
  const repo = hooked({ config: { mode: "shadow" } });
  buildIssue(repo, 104, { omit: ["dod"] });
  const r = repo.push("HEAD:main");
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /shadow/);
  assert.match(shadowLog(repo), /#104: no Definition of Done/);
  // A push from another worktree of the same repo writes to the same log.
  const wt = path.join(repo.tmp, "wt");
  repo.git("worktree", "add", "-q", "-b", "issue-105", wt, "origin/main");
  fs.mkdirSync(path.join(wt, "payments"));
  fs.writeFileSync(path.join(wt, "payments", "a.js"), "1\n");
  sh("git", ["add", "-A"], wt);
  sh("git", ["commit", "-qm", "quick money"], wt, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  sh("git", ["push", "-q", "origin", "HEAD:main"], wt, { CATALINA_HOME: ROOT });
  assert.match(shadowLog(repo), /payments\/a\.js/);
});

test("AC5: enforce mode with Catalina missing fails closed", () => {
  const repo = hooked();
  repo.write("docs/x.md", "x\n");
  repo.commit("quick docs");
  let code = 0;
  try {
    sh("git", ["push", "-q", "origin", "HEAD:main"], repo.cwd, { CATALINA_HOME: path.join(repo.tmp, "nowhere") });
  } catch (e) {
    code = e.status;
  }
  assert.strictEqual(code, 1);
});
