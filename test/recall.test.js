const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawnSync } = require("child_process");
const { makeRepo, tracking } = require("./helpers/repo");
const { recall } = require("../lib/recall");

function fixture() {
  const repo = makeRepo();
  repo.write(".claude/tracking/issue-300/tracking.md", tracking(300, { lessonsBlock: "- Callers of add assumed integers; test floats too." }));
  repo.write(".claude/tracking/issue-301/tracking.md", tracking(301, { lessonsBlock: "- Billing exports run late on Mondays." }).replace("Files: `src/add.js`, `test/add.test.js`.", "Epic: #50\nFiles: `billing/export.js`."));
  repo.write(".claude/tracking/issue-302/tracking.md", tracking(302)); // no lessons yet
  repo.write("lib/deep/thing.js", "1\n");
  repo.commit("thing (Refs #303)");
  repo.write(".claude/tracking/issue-303/tracking.md", tracking(303, { lessonsBlock: "- thing.js needs a restart after edits." }).replace("Files: `src/add.js`, `test/add.test.js`.", "No files named here."));
  return repo;
}

test("AC10: recall finds lessons by named path, by a directory, by the issue's own commits, and by epic", () => {
  const repo = fixture();
  assert.deepStrictEqual(recall({ cwd: repo.cwd, paths: ["src/add.js"] }).map((h) => h.issue), [300]);
  assert.deepStrictEqual(recall({ cwd: repo.cwd, paths: ["src"] }).map((h) => h.issue), [300]);
  assert.deepStrictEqual(recall({ cwd: repo.cwd, paths: ["lib/deep/thing.js"] }).map((h) => h.issue), [303]);
  assert.deepStrictEqual(recall({ cwd: repo.cwd, epic: "50" }).map((h) => h.issue), [301]);
  assert.deepStrictEqual(recall({ cwd: repo.cwd, paths: ["src/add.js", "billing/export.js"] }).map((h) => h.issue), [301, 300], "newest first");
});

test("AC10: no match prints None found", () => {
  const repo = fixture();
  const r = spawnSync("node", [path.join(__dirname, "..", "bin", "catalina"), "recall", "--paths", "nothing/here.js"], { cwd: repo.cwd, encoding: "utf8" });
  assert.strictEqual(r.stdout.trim(), "None found");
});
