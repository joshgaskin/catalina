/**
 * Catalina — the gate log: one line per gate run (a push to the default branch, a `gh pr merge`), pass or would-block.
 *
 * A project's pushes and merges run from many clones (a builder's worktree, the merge bot's own clone), and the
 * audit runs from yet another, so a log inside any one clone's git dir is read by nobody (#21). Every clone on the box
 * appends to <CATALINA_STATE_DIR or ~/.catalina-state>/<owner>__<name>/gate.log, and `catalina audit --shadow-report`
 * reads that one file. Passes are logged too: a report with no would-blocks and a report from a gate that never ran
 * must not read the same.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

function stateDir() {
  return process.env.CATALINA_STATE_DIR || path.join(os.homedir(), ".catalina-state");
}

function logPath(slug) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(slug))) throw new Error(`can't name the gate log: the repo is "${slug}", expected owner/name`);
  return path.join(stateDir(), slug.replace("/", "__"), "gate.log");
}

/** Append one run. A failure to write is reported on stderr and never blocks the push or merge it describes. */
function record(slug, entry, say = (s) => process.stderr.write(`${s}\n`)) {
  try {
    const file = logPath(slug);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), host: os.hostname(), repo: slug, ...entry }) + "\n");
  } catch (e) {
    say(`[catalina] couldn't write the gate log (${e.message}): this run is missing from \`catalina audit --shadow-report\``);
  }
}

/** → { file, entries }. Throws when the log doesn't exist: nothing has ever gated this project on this box. */
function read(slug) {
  const file = logPath(slug);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") throw new Error(`no gate log at ${file}: no push or merge has run the gate on this machine (is the pre-push hook or the catalina-gh wrapper installed and pointed at the same CATALINA_STATE_DIR?)`);
    throw e;
  }
  return { file, entries: text.split("\n").filter(Boolean).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new Error(`${file} line ${i + 1} is not JSON`);
    }
  }) };
}

/** A run that would have been blocked: ok is false (older entries, from shadow.log, are would-blocks by existing). */
const wouldBlock = (e) => e.ok === false || (e.ok === undefined && (e.reasons || []).length > 0);

module.exports = { stateDir, logPath, record, read, wouldBlock };
