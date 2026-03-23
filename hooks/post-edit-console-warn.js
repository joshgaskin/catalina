#!/usr/bin/env node
/**
 * PostToolUse Hook: Warn about console.log statements after edits
 *
 * Reports line numbers of any console.log found in the edited file.
 * Based on: github.com/affaan-m/everything-claude-code
 */

const fs = require("fs");
const path = require("path");

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (data.length < 1024 * 1024) data += chunk;
});

process.stdin.on("end", () => {
  try {
    const input = JSON.parse(data);
    const filePath = input.tool_input?.file_path;

    if (filePath && /\.(ts|tsx|js|jsx)$/.test(filePath)) {
      const resolved = path.resolve(filePath);
      if (fs.existsSync(resolved)) {
        const content = fs.readFileSync(resolved, "utf8");
        const lines = content.split("\n");
        const matches = [];

        lines.forEach((line, idx) => {
          if (/console\.log/.test(line)) {
            matches.push((idx + 1) + ": " + line.trim());
          }
        });

        if (matches.length > 0) {
          console.error("[Hook] console.log found in " + path.basename(filePath));
          matches.slice(0, 5).forEach((m) => console.error("  " + m));
          console.error("[Hook] Remove before committing");
        }
      }
    }
  } catch {
    // pass through
  }

  process.stdout.write(data);
  process.exit(0);
});
