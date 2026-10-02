#!/usr/bin/env node
/**
 * PreToolUse Hook: Infrastructure Guardrail
 *
 * Layer 2 of the three-layer safety model:
 *   Layer 1: Beliefs in CLAUDE.md (catches intent)
 *   Layer 2: This hook (makes bad actions impossible)
 *   Layer 3: Post-edit hooks (catches what slips through)
 *
 * Blocks destructive Bash commands with exit code 2.
 * Suggests safer alternatives in the stderr message.
 *
 * Escape hatch: CATALINA_GUARDRAIL_ALLOW=rm-rf,docker-down
 */

const os = require("os");

const DENYLIST = [
  {
    name: "rm-rf",
    pattern: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*\s+(?:-[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*)|-[a-zA-Z]*f[a-zA-Z]*\s+(?:-[a-zA-Z]*r|-[a-zA-Z]*r[a-zA-Z]*)|-rf\b|-fr\b)/,
    message:
      "Recursive force delete blocked. Remove specific files by name instead.",
  },
  {
    name: "docker-down",
    pattern: /\bdocker\s+compose\s+down\b/,
    message:
      "docker compose down blocked — removes containers and networks. Use 'docker compose stop' to stop without removing.",
  },
  {
    name: "drop-table",
    pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
    message: "DROP operations blocked. Use migrations for schema changes.",
  },
  {
    name: "force-push",
    pattern: /\bgit\s+push\s+.*--force(?!-with-lease)\b|\bgit\s+push\s+-f\b/,
    message:
      "Force push blocked. Use 'git push --force-with-lease' for safer force pushes.",
  },
  {
    name: "git-stash-shared",
    pattern: /(?:^|[;&|]\s*|\$\(\s*)git(?:\s+-C\s+\S+)?\s+stash\b/m,
    message:
      "git stash blocked: refs/stash is SHARED across all worktrees of this repo — a stash/pop here can eat another session's uncommitted work (#1089 near-miss: 25 of Josh's files). Commit to your branch instead; every git call in ILR work must be 'git -C <absolute-worktree-path> ...'.",
  },
  {
    name: "worktree-branch-override",
    pattern:
      /(?:^|[;&|(]\s*|\$\(\s*)git(?:\s+-C\s+\S+)?\s+(?:(?:switch|checkout)\b[^\n;&|]*?--ignore-other-worktrees\b|worktree\s+add\b[^\n;&|]*?\s(?:-f|--force)\b)/m,
    message:
      "Checking out a branch another worktree already has is blocked: worktrees share branch refs but not files, so the other checkout's files silently go stale under its branch (a real incident: a build merged into the shared integration branch this way and left the main checkout's files hours behind its own branch, one 'commit -a' away from reverting the morning's work). To merge into a shared branch, use a detached checkout: git checkout --detach origin/<branch> && git merge --no-ff <your-branch> && git push origin HEAD:<branch>.",
  },
  {
    name: "hard-reset",
    pattern: /\bgit\s+reset\s+--hard\b/,
    message:
      "Hard reset blocked. Commit to your branch (or 'git reset --soft') — do NOT reach for 'git stash': the stash stack is shared across every worktree of the repo.",
  },
  {
    name: "truncate",
    pattern: /\bTRUNCATE\s+TABLE\b/i,
    message:
      "TRUNCATE blocked. Use DELETE with a WHERE clause for targeted removal.",
  },
  {
    name: "git-clean",
    pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/,
    message:
      "git clean -f blocked. Review untracked files with 'git clean -n' (dry run) first.",
  },
  {
    name: "chmod-777",
    pattern: /\bchmod\s+777\b/,
    message:
      "chmod 777 blocked. Use more restrictive permissions (755 for dirs, 644 for files).",
  },
  {
    name: "disk-ops",
    pattern: />\s*\/dev\/sd|mkfs\b/,
    message: "Direct disk operations blocked.",
  },
];

// ---------------------------------------------------------------------------
// prod-direct: any file transfer or shell straight at a PRODUCTION host, outside the project's deploy script.
// Hosts come from config, never from this file:
//   <project>/.claude/catalina.json   { "production_hosts": ["p2production", "wpengine"] }   (found by walking up from cwd, so worktrees work)
//   ~/.claude/catalina.json           same shape, applies in every repo on this machine
// A host matches as a whole token: "wpengine" matches "ssh wpengine" but not "plus2.sftp.wpengine.com" or "wpengine-staging".
// Anchored to a command position (start of line / after ; & | ( $( ) so prose that merely mentions the host does not trip it.
// No hosts configured = rule inactive. Overrides: the human types "allow prod" in their message (that turn only; see
// humanAllowedProd below), or Claude Code is started with CATALINA_GUARDRAIL_ALLOW=prod-direct.
function productionHosts(cwd) {
  const fs = require("fs"), path = require("path");
  const files = [path.join(os.homedir(), ".claude", "catalina.json")];
  let dir = path.resolve(cwd || process.cwd());
  for (;;) {
    files.push(path.join(dir, ".claude", "catalina.json"));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const hosts = new Set();
  for (const f of files) {
    try {
      for (const h of JSON.parse(fs.readFileSync(f, "utf8")).production_hosts || []) {
        if (typeof h === "string" && h.trim()) hosts.add(h.trim());
      }
    } catch {}
  }
  return [...hosts];
}

function prodDirectRule(cwd) {
  const hosts = productionHosts(cwd);
  if (!hosts.length) return null;
  const alt = hosts.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return {
    name: "prod-direct",
    pattern: new RegExp(
      "(?:^|[;&|(]\\s*|\\$\\(\\s*)(?:[A-Za-z_][A-Za-z0-9_]*=(?:\"[^\"]*\"|'[^']*'|\\S*)\\s+)*(?:sshpass\\s+(?:-\\S+\\s+)*)?(?:sftp|scp|ssh|rsync|lftp)\\b[^\\n;&|]*?(?<![\\w.-])(?:" +
        alt +
        ")(?![\\w-])",
      "m"
    ),
    message:
      `Direct transfer to a production host (${hosts.join(", ")}) blocked. Production changes ship only through the project's deploy script after they ran on staging and the requester accepted them there (see /deploy). For a one-off, the human says "${ALLOW_PROD_PHRASE}" in their message (valid until their next message), or Claude Code is started with CATALINA_GUARDRAIL_ALLOW=prod-direct.`,
  };
}

// ---------------------------------------------------------------------------
// "allow prod": the human's own words unlock prod-direct for one turn.
// The hook reads the session transcript and finds the LAST message the human typed
// (origin.kind === "human", not meta). Only that message counts, so the permission
// lapses with their next message. Tool output, teammate / cross-session messages,
// task notifications, skill text and <pasted_content> blocks never count, so Claude
// cannot grant it to itself. Subagent transcripts never count. Missing or unreadable
// transcript = blocked (fail closed). Every use is logged to ~/.claude/guardrail-overrides.log.
const ALLOW_PROD_PHRASE = "allow prod";

function lastHumanMessage(transcriptPath) {
  const fs = require("fs");
  if (!transcriptPath || /[\\/]subagents[\\/]/.test(transcriptPath)) return null;
  let text;
  try {
    const size = fs.statSync(transcriptPath).size;
    const want = Math.min(size, 8 * 1024 * 1024);
    const fd = fs.openSync(transcriptPath, "r");
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    fs.closeSync(fd);
    text = buf.toString("utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (e.type !== "user" || e.isMeta || e.toolUseResult !== undefined) continue;
    if (!e.origin || e.origin.kind !== "human") continue;
    const c = e.message && e.message.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n");
    return null;
  }
  return null;
}

function humanAllowedProd(transcriptPath) {
  const msg = lastHumanMessage(transcriptPath);
  if (!msg) return null;
  const own = msg.replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content\b[^>]*>/gi, " ");
  return /\ballow\s+prod\b/i.test(own) ? own : null;
}

function logOverride(input, rule, command, msg) {
  try {
    const fs = require("fs"), path = require("path");
    fs.appendFileSync(
      path.join(os.homedir(), ".claude", "guardrail-overrides.log"),
      JSON.stringify({
        at: new Date().toISOString(),
        rule,
        session: input.session_id || null,
        cwd: input.cwd || null,
        command: command.substring(0, 300),
        human_said: msg.trim().substring(0, 200),
      }) + "\n"
    );
  } catch {}
}

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (data.length < 1024 * 1024) data += chunk;
});

process.stdin.on("end", () => {
  try {
    const input = JSON.parse(data);
    const command = input.tool_input?.command || "";

    if (command) {
      // Check allowlist from environment
      const allowRaw = process.env.CATALINA_GUARDRAIL_ALLOW || "";
      const allowed = new Set(
        allowRaw
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      );
      if (allowed.has("wpe-prod-direct")) allowed.add("prod-direct"); // old name of the rule, before hosts moved to config

      const prodDirect = prodDirectRule(input.cwd);
      for (const rule of prodDirect ? [...DENYLIST, prodDirect] : DENYLIST) {
        if (allowed.has(rule.name)) continue;
        if (rule.pattern.test(command)) {
          if (rule.name === "prod-direct") {
            const said = humanAllowedProd(input.transcript_path);
            if (said) {
              logOverride(input, rule.name, command, said);
              continue;
            }
          }
          process.stderr.write(
            `\n[Guardrail] BLOCKED: ${rule.message}\n` +
              `  Command: ${command.substring(0, 120)}${command.length > 120 ? "..." : ""}\n` +
              `  To override: set CATALINA_GUARDRAIL_ALLOW=${rule.name}\n\n`
          );
          process.stdout.write(data);
          process.exit(2);
        }
      }
    }
  } catch {
    // Fail open — don't block if we can't parse
  }

  process.stdout.write(data);
  process.exit(0);
});
