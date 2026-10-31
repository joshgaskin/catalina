/**
 * Catalina — project config, `.catalina/config.json`.
 *
 * Read from the remote's DEFAULT branch, never from the branch being pushed, so a branch
 * can't switch its own gate to shadow or raise enforce_from. `.catalina/**` is always
 * no_undo for the same reason: changing the gate needs an issue that passes the gate.
 */
const g = require("./git");

const CONFIG_PATH = ".catalina/config.json";

const DEFAULTS = {
  mode: "shadow", // shadow | enforce
  enforce_from: 1, // issues below this number are legacy: checked as quick commits
  no_undo: [],
  code_glob: ["**/*.{js,jsx,ts,tsx,mjs,cjs,py,rb,go,rs,php,sql,sh}"],
  test_glob: ["**/*.test.*", "**/*.spec.*", "**/test_*.py", "**/__tests__/**"],
  red_cmd: null, // e.g. "npx vitest run {files} --reporter=json --outputFile={report}"
  red_parser: "exit-code", // vitest | jest | node-test | exit-code
  red_setup: null, // shell run inside each temp worktree, e.g. "cp -al \"$CATALINA_ROOT/node_modules\" node_modules"
  red_timeout_s: 300,
  repo: null, // "owner/name"; parsed from the remote URL when absent
  branch_issue_pattern: "(?:^|/)issue-(\\d+)|(?:^|/)(\\d+)-",
};

const ALWAYS_NO_UNDO = [".catalina/**"];

/** Returns null when the project hasn't adopted Catalina (no config on the default branch). */
function load(cwd, remote = "origin") {
  const ref = g.defaultRef(cwd, remote);
  const text = g.show(ref, CONFIG_PATH, cwd);
  if (text === null) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${CONFIG_PATH} on ${ref} is not valid JSON: ${e.message}`);
  }
  const cfg = { ...DEFAULTS, ...raw, defaultRef: ref, remote };
  if (!["shadow", "enforce"].includes(cfg.mode)) throw new Error(`${CONFIG_PATH}: mode must be "shadow" or "enforce"`);
  cfg.no_undo = [...ALWAYS_NO_UNDO, ...(raw.no_undo || [])];
  return cfg;
}

module.exports = { load, DEFAULTS, CONFIG_PATH };
