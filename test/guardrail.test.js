const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawnSync } = require("child_process");

const HOOK = path.join(__dirname, "..", "hooks", "pre-tool-guardrail.js");
const spawnHook = (command) =>
  spawnSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), encoding: "utf8", env: { ...process.env, CATALINA_GUARDRAIL_ALLOW: "" } });
const runHook = (command) => spawnHook(command).status;
const decisionOf = (command) => {
  try {
    return JSON.parse(spawnHook(command).stdout).hookSpecificOutput?.permissionDecision;
  } catch {
    return undefined;
  }
};

test("AC6: skipping hooks on push or commit is refused; plain push, dry-run push and -m text are allowed", () => {
  for (const c of ["git push --no-verify origin main", "cd /x && git -C /x push origin HEAD:main --no-verify", "git commit --no-verify -m x", "git commit -n -m x"]) {
    assert.strictEqual(runHook(c), 2, c);
  }
  for (const c of ["git push origin main", "git push -n origin main", 'git commit -m "explain the -n flag"', "git commit -am x"]) {
    assert.strictEqual(runHook(c), 0, c);
  }
});

test("a recursive force delete asks the user instead of being refused", () => {
  for (const c of ["rm -rf /tmp/x", "rm -fr build", "rm -r -f dist", "cd /tmp && rm -Rf a b", "rm -r dir", "rm -v --recursive dir"]) {
    assert.strictEqual(runHook(c), 0, c);
    assert.strictEqual(decisionOf(c), "ask", c);
  }
  for (const c of ["rm /tmp/x", "rm -f foo-r", "git rm -r --cached dist", "ls -la"]) {
    assert.strictEqual(runHook(c), 0, c);
    assert.strictEqual(decisionOf(c), undefined, c);
  }
});

test("a hard block in the same command still refuses when a delete only asks", () => {
  assert.strictEqual(runHook("rm -rf build && git push --force origin main"), 2);
});
