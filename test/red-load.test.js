/**
 * #19: what a load error at the merge-base must say to count as red. A fake vitest (tools/fake-vitest.js, committed
 * in the fixture) writes the JSON report shapes vitest, jest and node produce, so each parser's text is read for real.
 */
const test = require("node:test");
const assert = require("node:assert");
const { makeRepo, tracking, verification } = require("./helpers/repo");
const { check } = require("../lib/check");
const { missingImport } = require("../lib/red");

const FAKE = `const fs = require("fs");
const path = require("path");
const [report, message, ...files] = process.argv.slice(2);
if (fs.existsSync("src/mul.js")) {
  fs.writeFileSync(report, JSON.stringify({ testResults: files.map((f) => ({ name: path.resolve(f), status: "passed", assertionResults: [{ status: "passed" }], message: "" })) }));
  process.exit(0);
}
const text = message.replace("FILE", path.resolve(files[0]));
fs.writeFileSync(report, JSON.stringify({ testResults: files.map((f, i) => ({ name: path.resolve(f), status: "failed", assertionResults: [], message: i === 0 ? text : "" })) }));
process.exit(1);
`;

/** A repo whose red command is the fake vitest; the change adds src/mul.js and test/mul.test.js. */
function issue(n, message, { extraTests = false } = {}) {
  const repo = makeRepo({ config: { red_parser: "vitest", red_cmd: `node tools/fake-vitest.js {report} ${JSON.stringify(message)} {files}` } });
  repo.write("tools/fake-vitest.js", FAKE);
  repo.commit("fake vitest");
  repo.git("push", "-q", "origin", "HEAD:main");
  repo.git("checkout", "-q", "-b", `issue-${n}`, "origin/main");
  repo.write("src/mul.js", "module.exports = (a, b) => a * b;\n");
  repo.write("test/mul.test.js", "// test\n");
  if (extraTests) repo.write("test/other.test.js", "// test\n");
  const fix = repo.commit(`mul (Refs #${n})`);
  repo.write(`.claude/tracking/issue-${n}/tracking.md`, tracking(n));
  repo.write(`.claude/tracking/issue-${n}/verification.jsonl`, verification(fix));
  const tip = repo.commit(`evidence (Refs #${n})`);
  return check(n, { cwd: repo.cwd, source: "commit", red: "run", sha: tip });
}

const reasonsOf = (r) => r.reasons.join(" | ");

for (const [name, msg] of [
  ["vitest relative import", "Cannot find module '../src/mul' imported from 'FILE'"],
  ["vitest relative import with the extension", "Cannot find module '../src/mul.js' imported from 'FILE'"],
  ["vite resolver", `Failed to resolve import "../src/mul" from "test/mul.test.js". Does the file exist?`],
  ["jest", "Cannot find module '../src/mul' from 'test/mul.test.js'"],
  ["an aliased import", "Cannot find module '@/mul' imported from 'FILE'"],
]) {
  test(`#19: ${name} naming a module the change adds is red`, () => {
    const r = issue(200, msg);
    // the alias maps @/ to src/, which holds mul.js
    assert.deepStrictEqual(r.reasons, [], reasonsOf(r));
  });
}

for (const [name, msg] of [
  ["a package that isn't installed", "Cannot find package 'left-pad-zz' imported from 'FILE'"],
  ["a relative module the change doesn't add", "Cannot find module '../src/never-added' imported from 'FILE'"],
  ["a syntax error", 'Transform failed with 1 error:\nFILE:2:10: ERROR: Unexpected ";"'],
  ["an empty message", ""],
]) {
  test(`#19: ${name} is not red (control)`, () => {
    const r = issue(201, msg);
    assert.ok(reasonsOf(r).includes("failed to load, not an assertion, on main, and not because of a module this change adds"), reasonsOf(r));
  });
}

test("#19: with two test files, one explained and one not, the unexplained error refuses (control)", () => {
  // The fake writes the message for the first file and an empty message for the second.
  const r = issue(202, "Cannot find module '../src/mul' imported from 'FILE'", { extraTests: true });
  assert.ok(reasonsOf(r).includes("not because of a module this change adds"), reasonsOf(r));
});

test("#19: missingImport reads each runner's wording, and nothing else", () => {
  assert.deepStrictEqual(missingImport("Cannot find module '../a' imported from '/x/t.ts'"), { spec: "../a", from: "/x/t.ts" });
  assert.deepStrictEqual(missingImport("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/x/a.js' imported from /x/t.js"), { spec: "/x/a.js", from: "/x/t.js" });
  assert.deepStrictEqual(missingImport("Error: Cannot find module '../a'\nRequire stack:\n- /x/t.js\n- /x/r.js"), { spec: "../a", from: "/x/t.js" });
  assert.strictEqual(missingImport("TypeError: x is not a function"), null);
});
