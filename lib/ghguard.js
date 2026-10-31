/**
 * Catalina — `catalina-gh`: a `gh` for merge bots that runs `catalina gate` on a PR's head before `gh pr merge`.
 *
 * A merge on GitHub runs no git hook, so an agent that merges its own PRs skips the push gate entirely. Put this
 * ahead of the real gh on the agent's PATH (a wrapper that sets CATALINA_REAL_GH and execs this file). Every other
 * command passes straight through.
 *
 * On `gh pr merge <PR> [-R owner/name]`: fetch the PR head into the bot's own clone (CATALINA_GATE_DIR, default
 * ~/.catalina-gate/<name>), run the push rule over the commits it adds (prepush.branchGate), then
 *   - not adopted, or passes → merge;
 *   - fails, mode "shadow"  → merge, and log the would-refuse to the clone's shadow log (audit --shadow-report);
 *   - fails, mode "enforce" → refuse with the reasons (exit 1).
 * CATALINA_MERGE_ALLOW=1 merges anyway and appends to the clone's bypass.log. If the gate can't run at all (GitHub
 * down, a bad clone), the merge is refused: an unknown result is never a pass.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const g = require("./git");
const { branchGate } = require("./prepush");

function realGh() {
  if (process.env.CATALINA_REAL_GH) return process.env.CATALINA_REAL_GH;
  const self = fs.realpathSync(process.argv[1]);
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const p = path.join(dir, "gh");
    try {
      if (fs.realpathSync(p) !== self) return p;
    } catch {}
  }
  throw new Error("no real gh on PATH (set CATALINA_REAL_GH)");
}

function ghJson(gh, args) {
  const r = spawnSync(gh, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`gh ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  return JSON.parse(r.stdout);
}

/** `pr merge [<PR>] [-R repo] [flags…]` → { pr, repo } (pr is undefined for the current branch's PR). */
function parseMerge(args) {
  const rest = args.slice(2);
  let repo;
  let pr;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-R" || a === "--repo") repo = rest[++i];
    else if (a.startsWith("--repo=")) repo = a.slice(7);
    else if (a.startsWith("-")) {
      if (["-b", "--body", "-F", "--body-file", "-t", "--subject", "-A", "--author-email", "--match-head-commit"].includes(a)) i++;
    } else if (pr === undefined) pr = a;
  }
  return { pr, repo };
}

function appendJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

/**
 * `catalina gate` on a PR's current head: fetched into the bot's own clone, the push rule over the commits it adds.
 * → { adopted, ok, mode, sha, reasons, repo, pr }. Not adopted (no config on the PR's base branch, a 404) → ok, no clone.
 */
function prGate({ pr, repo, gh = realGh() }) {
  const info = ghJson(gh, ["repo", "view", ...(repo ? [repo] : []), "--json", "nameWithOwner,url"]);
  const view = ghJson(gh, ["pr", "view", ...(pr ? [pr] : []), ...(repo ? ["-R", repo] : []), "--json", "number,headRefOid,baseRefName"]);
  // Not adopted (no config on the base branch): nothing to check, and no clone of a repo the gate never reads.
  const cfgPath = `repos/${info.nameWithOwner}/contents/.catalina/config.json?ref=${encodeURIComponent(view.baseRefName || "main")}`;
  const cfg = spawnSync(gh, ["api", cfgPath], { encoding: "utf8" });
  if (cfg.status !== 0) {
    if (/HTTP 404|Not Found/i.test(cfg.stderr || "")) return { adopted: false, ok: true, reasons: [], repo: info.nameWithOwner, pr: view.number, sha: view.headRefOid };
    throw new Error(`gh api ${cfgPath} failed: ${(cfg.stderr || "").trim()}`);
  }
  const name = info.nameWithOwner.split("/").pop();
  const dir = path.join(process.env.CATALINA_GATE_DIR || path.join(os.homedir(), ".catalina-gate"), name);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    g.git(["clone", "-q", info.url, dir], path.dirname(dir));
  }
  const ref = `refs/catalina/pr-${view.number}`;
  g.git(["fetch", "-q", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*", `+refs/pull/${view.number}/head:${ref}`], dir);
  return { ...branchGate(ref, dir), repo: info.nameWithOwner, pr: view.number, dir };
}

function guardMerge(args, gh, say) {
  const r = prGate({ ...parseMerge(args), gh });
  if (r.ok) return true;
  const label = `${r.repo}#${r.pr}`;
  const entry = { at: new Date().toISOString(), host: os.hostname(), kind: "merge", repo: r.repo, pr: r.pr, sha: r.sha, reasons: r.reasons };
  const logDir = path.join(g.commonDir(r.dir), "catalina");
  if (process.env.CATALINA_MERGE_ALLOW === "1") {
    say(`[catalina] CATALINA_MERGE_ALLOW=1: merging ${label} although catalina gate fails (recorded):\n${r.reasons.map((x) => `  - ${x}`).join("\n")}`);
    appendJson(path.join(logDir, "bypass.log"), entry);
    return true;
  }
  if (r.mode !== "enforce") {
    say(`[catalina] shadow mode: this merge would be refused (logged, allowed): ${label}\n${r.reasons.map((x) => `  - ${x}`).join("\n")}`);
    appendJson(path.join(logDir, "shadow.log"), entry);
    return true;
  }
  say(
    `[catalina] merge refused: ${label} at ${r.sha.slice(0, 7)} doesn't pass catalina gate:\n` +
      `${r.reasons.map((x) => `  - ${x}`).join("\n")}\n` +
      "Fix it on the PR branch: write or finish .claude/tracking/issue-<N>/ (spec, premortem with IDs, lessons applied),\n" +
      "witness it, and run `catalina check <N> --witness` until it exits 0. Then merge again.",
  );
  return false;
}

function main(args) {
  const say = (s) => process.stderr.write(`${s}\n`);
  let gh;
  try {
    gh = realGh();
  } catch (e) {
    say(`[catalina] ${e.message}`);
    return 1;
  }
  if (args[0] === "pr" && args[1] === "merge") {
    let ok;
    try {
      ok = guardMerge(args, gh, say);
    } catch (e) {
      if (process.env.CATALINA_MERGE_ALLOW === "1") ok = true;
      else {
        say(`[catalina] merge refused: catalina gate couldn't run (${e.message}). Retry, or CATALINA_MERGE_ALLOW=1 to merge anyway (recorded).`);
        return 1;
      }
    }
    if (!ok) return 1;
  }
  const r = spawnSync(gh, args, { stdio: "inherit" });
  return r.status ?? 1;
}

module.exports = { main, parseMerge, prGate };
