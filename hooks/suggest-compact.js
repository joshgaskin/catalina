#!/usr/bin/env node
/**
 * PreToolUse Hook: Suggest /compact at logical intervals
 *
 * Tracks tool call count per session and suggests compaction every 50 calls.
 * Based on: github.com/affaan-m/everything-claude-code
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const THRESHOLD = 50;
const INTERVAL = 25;

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (data.length < 1024 * 1024) data += chunk;
});

process.stdin.on("end", () => {
  // Pass through stdin immediately
  process.stdout.write(data);

  try {
    const sessionId = process.env.CLAUDE_SESSION_ID || process.ppid || "default";
    const counterFile = path.join(os.tmpdir(), `claude-tool-count-${sessionId}`);

    let count = 1;
    try {
      const existing = fs.readFileSync(counterFile, "utf8").trim();
      const parsed = parseInt(existing, 10);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 100000) {
        count = parsed + 1;
      }
    } catch {
      // File doesn't exist yet
    }

    fs.writeFileSync(counterFile, String(count));

    if (count === THRESHOLD) {
      console.error(`[Hook] ${THRESHOLD} tool calls — consider /compact if switching phases`);
    } else if (count > THRESHOLD && (count - THRESHOLD) % INTERVAL === 0) {
      console.error(`[Hook] ${count} tool calls — good checkpoint for /compact`);
    }
  } catch {
    // Non-blocking
  }

  process.exit(0);
});
