const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawnSync } = require("child_process");

const HOOK = path.join(__dirname, "..", "hooks", "pre-tool-guardrail.js");
const runHook = (command) =>
  spawnSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), encoding: "utf8", env: { ...process.env, CATALINA_GUARDRAIL_ALLOW: "" } }).status;

test("AC6: skipping hooks on push or commit is refused; plain push, dry-run push and -m text are allowed", () => {
  for (const c of ["git push --no-verify origin main", "cd /x && git -C /x push origin HEAD:main --no-verify", "git commit --no-verify -m x", "git commit -n -m x"]) {
    assert.strictEqual(runHook(c), 2, c);
  }
  for (const c of ["git push origin main", "git push -n origin main", 'git commit -m "explain the -n flag"', "git commit -am x"]) {
    assert.strictEqual(runHook(c), 0, c);
  }
});
