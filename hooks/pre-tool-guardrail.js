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
    name: "hard-reset",
    pattern: /\bgit\s+reset\s+--hard\b/,
    message:
      "Hard reset blocked. Use 'git stash' to save changes or 'git reset --soft' to preserve staged work.",
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

      for (const rule of DENYLIST) {
        if (allowed.has(rule.name)) continue;
        if (rule.pattern.test(command)) {
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
