/**
 * Test fixtures: a bare "remote" plus a clone, with a tiny node project whose
 * red proof runs under `node --test`. Every helper shells out to real git.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");

function sh(cmd, args, cwd, env = {}) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...env },
  });
}

const BUGGY = "module.exports = (a, b) => a - b;\n";
const FIXED = "module.exports = (a, b) => a + b;\n";
const TEST = "const test = require('node:test');\nconst assert = require('node:assert');\nconst add = require('../src/add');\ntest('adds', () => assert.strictEqual(add(2, 3), 5));\n";

function makeRepo(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catalina-test-"));
  const bare = path.join(tmp, "remote.git");
  const cwd = path.join(tmp, "work");
  sh("git", ["init", "-q", "--bare", "-b", "main", bare], tmp);
  sh("git", ["clone", "-q", bare, cwd], tmp);
  const repo = {
    tmp,
    bare,
    cwd,
    git: (...args) => sh("git", args, cwd).trim(),
    write(rel, text) {
      const p = path.join(cwd, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    },
    rm(rel) {
      fs.rmSync(path.join(cwd, rel), { force: true });
    },
    commit(msg) {
      sh("git", ["add", "-A"], cwd);
      sh("git", ["commit", "-q", "--allow-empty", "-m", msg], cwd);
      return repo.git("rev-parse", "HEAD");
    },
    config(over = {}) {
      return {
        mode: "enforce",
        enforce_from: 100,
        no_undo: ["payments/**"],
        red_cmd: "node --test {files}",
        red_parser: "node-test",
        red_timeout_s: 60,
        repo: "o/r",
        ...over,
      };
    },
  };
  repo.write(".catalina/config.json", JSON.stringify(repo.config(opts.config)));
  repo.write("src/add.js", opts.baseFixed ? FIXED : BUGGY);
  repo.write("README.md", "fixture\n");
  repo.commit("init");
  repo.git("push", "-q", "-u", "origin", "main");
  sh("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], cwd);
  return repo;
}

function tracking(n, o = {}) {
  const parts = [`# Issue #${n}: fix add`];
  if (!o.omit?.includes("dod")) parts.push("## Definition of Done\n- [ ] add returns the sum");
  if (!o.omit?.includes("ac")) parts.push("## Acceptance Criteria\n- [ ] AC1: add returns the sum of two numbers");
  parts.push("## Design Notes\nFiles: `src/add.js`, `test/add.test.js`.");
  if (!o.omit?.includes("premortem")) {
    parts.push(o.trivial ? "## Premortem\nTrivial: one-line arithmetic fix" : `## Premortem\n- **P1 ${o.p1Title || "Callers relied on subtraction"}** ${o.dash || "—"} early sign: other tests fail; mitigation: run the suite`);
  }
  if (!o.omit?.includes("lessons")) parts.push(`## Lessons applied\n${o.lessons ?? "None found"}`);
  parts.push(`## Review History\n${o.review || ""}`);
  if (o.lessonsBlock) parts.push(`## Lessons\n${o.lessonsBlock}`);
  return parts.join("\n\n") + "\n";
}

function verification(sha, o = {}) {
  const lines = [];
  if (!o.omit?.includes("acline")) {
    lines.push({ ac: "AC1: add returns the sum", result: "pass", method: "programmatic", observable: false, observable_reason: "library function", evidence: "node --test green", ...(o.noSha ? {} : { sha }) });
  }
  if (!o.omit?.includes("pmline") && !o.trivial) lines.push({ premortem: o.pmId || "P1", outcome: o.outcome || "did_not_occur", evidence: "suite green" });
  if (o.exempt) lines.push({ red_green: "none", reason: o.exempt });
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/**
 * Builds issue N on branch issue-N: a fix commit (Refs #N), then a tracking-only evidence
 * commit naming the fix commit as the witnessed sha. Returns {base, fix, tip}.
 */
function buildIssue(repo, n, o = {}) {
  repo.git("checkout", "-q", "-b", `issue-${n}`, "origin/main");
  const base = repo.git("rev-parse", "HEAD");
  if (o.code !== false) repo.write("src/add.js", FIXED);
  if (o.test !== false) repo.write(o.testPath || "test/add.test.js", o.testText || TEST);
  if (o.docsOnly) repo.write("docs/notes.md", "notes\n");
  const fix = repo.commit(`fix add (Refs #${n})`);
  const dir = `.claude/tracking/issue-${n}`;
  repo.write(`${dir}/tracking.md`, tracking(n, o));
  repo.write(`${dir}/verification.jsonl`, verification(o.witnessSha || fix, o));
  const tip = repo.commit(`evidence (Refs #${n})`);
  return { base, fix, tip };
}

module.exports = { ROOT, sh, makeRepo, tracking, verification, buildIssue, BUGGY, FIXED, TEST };
