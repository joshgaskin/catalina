// catalina-gh: a `gh` that runs `catalina gate` on a PR's head before `gh pr merge`, for merge bots.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { makeRepo, buildIssue, ROOT } = require("./helpers/repo");

const STUB = path.join(__dirname, "helpers", "gh-stub.js");

function setup(mode, issueOpts = {}) {
  const repo = makeRepo({ config: { mode } });
  const { tip } = buildIssue(repo, 301, issueOpts);
  repo.git("push", "-q", "origin", "HEAD:refs/pull/7/head");
  const state = path.join(repo.tmp, "gh-state.json");
  fs.writeFileSync(state, JSON.stringify({ remote: path.join(repo.tmp, "remote.git"), prs: { 7: { number: 7, headRefOid: tip, baseRefName: "main" } } }));
  const run = (args, env = {}) =>
    spawnSync("node", [path.join(ROOT, "bin", "catalina-gh"), ...args], {
      cwd: repo.tmp,
      encoding: "utf8",
      env: { ...process.env, CATALINA_REAL_GH: STUB, CATALINA_GH_STATE: state, CATALINA_GATE_DIR: path.join(repo.tmp, "gate"), ...env },
    });
  const merged = () => JSON.parse(fs.readFileSync(state, "utf8")).merged || [];
  const gateLog = (name) => {
    const p = path.join(repo.tmp, "gate", "r", ".git", "catalina", name);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  };
  return { repo, tip, run, merged, gateLog };
}

test("gh-guard: enforce refuses a merge whose head fails catalina gate, with the reasons", () => {
  const s = setup("enforce", { omit: ["dod"] });
  const r = s.run(["pr", "merge", "7", "-R", "o/r", "--squash"]);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /merge refused: o\/r#7/);
  assert.match(r.stderr, /#301: no Definition of Done/);
  assert.deepStrictEqual(s.merged(), []);
});

test("gh-guard: a head that passes is merged", () => {
  const s = setup("enforce");
  const r = s.run(["pr", "merge", "7", "-R", "o/r", "--squash"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(s.merged(), ["7"]);
});

test("gh-guard: shadow merges anyway and logs the would-refuse", () => {
  const s = setup("shadow", { omit: ["dod"] });
  const r = s.run(["pr", "merge", "7", "-R", "o/r"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(s.merged(), ["7"]);
  assert.match(r.stderr, /shadow mode: this merge would be refused/);
  const line = JSON.parse(s.gateLog("shadow.log").trim().split("\n").pop());
  assert.strictEqual(line.kind, "merge");
  assert.strictEqual(line.sha, s.tip);
});

test("gh-guard: CATALINA_MERGE_ALLOW=1 merges and records the bypass", () => {
  const s = setup("enforce", { omit: ["dod"] });
  const r = s.run(["pr", "merge", "7", "-R", "o/r"], { CATALINA_MERGE_ALLOW: "1" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(s.merged(), ["7"]);
  assert.match(s.gateLog("bypass.log"), /"pr":7/);
});

test("gh-guard: a repo with no .catalina/config.json is merged without cloning it", () => {
  const s = setup("enforce", { omit: ["dod"] });
  const st = path.join(s.repo.tmp, "gh-state.json");
  fs.writeFileSync(st, JSON.stringify({ ...JSON.parse(fs.readFileSync(st, "utf8")), adopted: false }));
  const r = s.run(["pr", "merge", "7", "-R", "o/r"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(s.merged(), ["7"]);
  assert.ok(!fs.existsSync(path.join(s.repo.tmp, "gate", "r")), "no clone");
});

test("gh-guard: GitHub failing is a refusal, never a pass", () => {
  const s = setup("enforce");
  const st = path.join(s.repo.tmp, "gh-state.json");
  fs.writeFileSync(st, JSON.stringify({ ...JSON.parse(fs.readFileSync(st, "utf8")), githubDown: true }));
  const r = s.run(["pr", "merge", "7", "-R", "o/r"]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /couldn't run/);
  assert.deepStrictEqual(s.merged(), []);
});

test("gh-guard: every other gh command passes straight through", () => {
  const s = setup("enforce");
  const r = s.run(["pr", "view", "7"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).number, 7);
});
