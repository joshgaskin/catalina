const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { makeRepo, buildIssue, tracking, verification } = require("./helpers/repo");
const { audit } = require("../lib/audit");

const STUB = path.join(__dirname, "helpers", "gh-stub.js");
fs.chmodSync(STUB, 0o755);

function withGh(repo, state = {}) {
  const file = path.join(repo.tmp, "gh-state.json");
  fs.writeFileSync(file, JSON.stringify({ pulls: {}, issues: [], labels: [], ...state }));
  process.env.CATALINA_GH = STUB;
  process.env.CATALINA_GH_STATE = file;
  return { read: () => JSON.parse(fs.readFileSync(file, "utf8")), file };
}

const pushMain = (repo) => repo.git("push", "-q", "origin", "HEAD:main");

/** Five commits on main: three that pass, two that don't. */
function fixture() {
  const repo = makeRepo();
  // a) a direct push of a witnessed issue
  buildIssue(repo, 201);
  pushMain(repo);
  // b) a squash merge of a witnessed PR whose squash message lost "Refs"
  repo.write("src/mul.js", "module.exports = (a, b) => a + b;\n");
  repo.commit("mul stub");
  pushMain(repo);
  repo.git("checkout", "-q", "-b", "issue-202", "origin/main");
  repo.write("src/mul.js", "module.exports = (a, b) => a * b;\n");
  repo.write("test/mul.test.js", "const test = require('node:test');\nconst assert = require('node:assert');\nconst mul = require('../src/mul');\ntest('mul', () => assert.strictEqual(mul(2, 3), 6));\n");
  const fix = repo.commit("fix mul (Refs #202)");
  repo.write(".claude/tracking/issue-202/tracking.md", tracking(202));
  repo.write(".claude/tracking/issue-202/verification.jsonl", verification(fix));
  const pr = { tip: repo.commit("evidence (Refs #202)") };
  repo.git("push", "-q", "origin", "HEAD:refs/pull/7/head");
  repo.git("checkout", "-q", "-B", "main", "origin/main");
  repo.git("merge", "-q", "--squash", "issue-202");
  const squash = repo.commit("fix mul (#7)");
  pushMain(repo);
  // c) a quick commit outside no_undo
  repo.write("docs/a.md", "a\n");
  repo.commit("docs");
  // d) a quick commit inside no_undo
  repo.write("payments/a.js", "1\n");
  const money = repo.commit("money, no issue");
  pushMain(repo);
  // e) a direct push of an issue with no Definition of Done
  const bad = buildIssue(repo, 203, { omit: ["dod"], code: false, test: false, docsOnly: true, exempt: "docs only" });
  pushMain(repo);
  const pulls = { [squash]: [{ number: 7, merge_commit_sha: squash, head: { sha: pr.tip, ref: "issue-202-fix-add" }, title: "fix add", body: "" }] };
  return { repo, pulls, money, bad };
}

test("AC7: the audit accepts direct, squash and quick commits and lists the rest", () => {
  const { repo, pulls, money, bad } = fixture();
  const gh = withGh(repo, { pulls });
  const r = audit({ cwd: repo.cwd, since: "72h", dryRun: true });
  assert.deepStrictEqual(r.findings.map((f) => f.sha).sort(), [money, bad.tip].sort(), JSON.stringify(r.findings, null, 1));
  assert.strictEqual(gh.read().issues.length, 0, "dry run files nothing");
});

test("AC7: findings are filed once; a re-run files none", () => {
  const { repo, pulls } = fixture();
  const gh = withGh(repo, { pulls });
  audit({ cwd: repo.cwd, since: "72h" });
  const filed = gh.read().issues;
  assert.strictEqual(filed.length, 2);
  assert.ok(filed.every((i) => /^catalina-unchecked: [0-9a-f]{7}$/.test(i.title) && i.labels.includes("catalina-unchecked")));
  audit({ cwd: repo.cwd, since: "72h" });
  assert.strictEqual(gh.read().issues.length, 2);
});

test("AC7: eight unchecked commits file five plus one summary", () => {
  const repo = makeRepo();
  for (let i = 0; i < 8; i++) {
    repo.write(`payments/p${i}.js`, `${i}\n`);
    repo.commit(`money ${i}`);
  }
  pushMain(repo);
  const gh = withGh(repo);
  audit({ cwd: repo.cwd, since: "72h" });
  const titles = gh.read().issues.map((i) => i.title);
  assert.strictEqual(titles.length, 6);
  assert.strictEqual(titles.filter((t) => /summary/.test(t)).length, 1);
  assert.match(gh.read().issues.find((i) => /summary/.test(i.title)).body, /3 more/);
});

test("AC8: --shadow-report groups the shared shadow log by day", () => {
  const repo = makeRepo();
  withGh(repo);
  const log = path.join(repo.cwd, ".git", "catalina", "shadow.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const now = Date.now();
  const line = (ms, r) => JSON.stringify({ at: new Date(ms).toISOString(), host: "h", sha: "abc1234", reasons: [r] });
  fs.writeFileSync(log, [line(now - 3600e3, "#300: x"), line(now - 3600e3, "#301: y"), line(now - 30 * 3600e3, "#302: z"), line(now - 10 * 86400e3, "too old")].join("\n") + "\n");
  const r = audit({ cwd: repo.cwd, since: "72h", shadowReport: true });
  assert.strictEqual(r.days.length, 2);
  assert.deepStrictEqual(r.days.map((d) => d.count).sort(), [1, 2]);
  assert.ok(!JSON.stringify(r.days).includes("too old"));
});

test("audit --json prints the findings for a cron to read", () => {
  const { repo, pulls, money, bad } = fixture();
  withGh(repo, { pulls });
  const { spawnSync } = require("child_process");
  const r = spawnSync("node", [path.join(__dirname, "..", "bin", "catalina"), "audit", "--dry-run", "--json"], { cwd: repo.cwd, encoding: "utf8", env: process.env });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.adopted, true);
  assert.deepStrictEqual(out.findings.map((f) => f.sha).sort(), [money, bad.tip].sort());
  assert.ok(out.findings.every((f) => Array.isArray(f.reasons) && f.reasons.length));
});

test("audit: a commit GitHub doesn't know (never pushed there) has no PR; other GitHub errors still fail", () => {
  const { repo, pulls, money, bad } = fixture();
  withGh(repo, { pulls, unknownCommits: [money] });
  const r = audit({ cwd: repo.cwd, since: "72h", dryRun: true });
  assert.deepStrictEqual(r.findings.map((f) => f.sha).sort(), [money, bad.tip].sort());
  withGh(repo, { pulls, githubDown: true });
  assert.throws(() => audit({ cwd: repo.cwd, since: "72h", dryRun: true }), /502/);
});

test("audit: a repair PR that closes a catalina-unchecked issue doesn't get that audit issue checked as work (#13)", () => {
  const { repo, pulls, money, bad } = fixture();
  const [squash] = Object.keys(pulls);
  // issue #150 is an earlier audit finding; the re-witness PR closes it and Refs the real issue
  const issues = Array.from({ length: 150 }, (_, k) => ({ title: `old ${k + 1}`, body: "", labels: [] }));
  issues[149] = { title: "catalina-unchecked: abc1234", body: "", labels: ["catalina-unchecked"] };
  pulls[squash][0].body = "Closes #150\nRefs #202";
  withGh(repo, { pulls, issues });
  const r = audit({ cwd: repo.cwd, since: "72h", dryRun: true });
  assert.deepStrictEqual(r.findings.map((f) => f.sha).sort(), [money, bad.tip].sort(), JSON.stringify(r.findings, null, 1));
  // a direct push that names an audit issue isn't checked as that issue either
  repo.write("src/z.js", "1\n");
  repo.commit("re-witness (Closes #150)");
  pushMain(repo);
  const r2 = audit({ cwd: repo.cwd, since: "72h", dryRun: true });
  assert.ok(!r2.findings.some((f) => /#150/.test(f.what)), JSON.stringify(r2.findings, null, 1));
});

test("audit: a PR body's \"#N (Refs #M)\" says what #N did, so #M isn't checked as this PR's work (plus2 #2423)", () => {
  const { repo, pulls, money, bad } = fixture();
  const [squash] = Object.keys(pulls);
  // issue #204 is only explained in the body's prose; checking it would flag the squash
  pulls[squash][0].body = "Main was red because #2413 (Refs #204) added crons.\n\nRefs #202";
  withGh(repo, { pulls });
  const r = audit({ cwd: repo.cwd, since: "72h", dryRun: true });
  assert.deepStrictEqual(r.findings.map((f) => f.sha).sort(), [money, bad.tip].sort(), JSON.stringify(r.findings, null, 1));
  // the PR's own Refs, on a line or ending a sentence, still names the issue
  for (const body of ["Refs #204", "Test fixture only. Refs #204.", "This closes #204 too (Refs #204)."]) {
    pulls[squash][0].body = body;
    withGh(repo, { pulls });
    const r2 = audit({ cwd: repo.cwd, since: "72h", dryRun: true });
    assert.ok(r2.findings.some((f) => /issue #204/.test(f.what)), body + JSON.stringify(r2.findings, null, 1));
  }
});
