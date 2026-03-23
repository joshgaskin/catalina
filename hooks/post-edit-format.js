#!/usr/bin/env node
/**
 * PostToolUse Hook: Auto-format JS/TS files after edits
 *
 * Auto-detects Biome or Prettier by config file presence, then formats.
 * Fails silently if no formatter found.
 * Based on: github.com/affaan-m/everything-claude-code
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (data.length < 1024 * 1024) data += chunk;
});

function findProjectRoot(startDir) {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return startDir;
}

function detectFormatter(projectRoot) {
  for (const cfg of ["biome.json", "biome.jsonc"]) {
    if (fs.existsSync(path.join(projectRoot, cfg))) return "biome";
  }
  for (const cfg of [
    ".prettierrc", ".prettierrc.json", ".prettierrc.js", ".prettierrc.cjs",
    ".prettierrc.mjs", ".prettierrc.yml", ".prettierrc.yaml", ".prettierrc.toml",
    "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs",
  ]) {
    if (fs.existsSync(path.join(projectRoot, cfg))) return "prettier";
  }
  return null;
}

process.stdin.on("end", () => {
  try {
    const input = JSON.parse(data);
    const filePath = input.tool_input?.file_path;

    if (filePath && /\.(ts|tsx|js|jsx)$/.test(filePath)) {
      try {
        const projectRoot = findProjectRoot(path.dirname(path.resolve(filePath)));
        const formatter = detectFormatter(projectRoot);

        if (formatter === "biome") {
          execFileSync("npx", ["@biomejs/biome", "format", "--write", filePath], {
            cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"], timeout: 15000,
          });
        } else if (formatter === "prettier") {
          execFileSync("npx", ["prettier", "--write", filePath], {
            cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"], timeout: 15000,
          });
        }
      } catch {
        // Formatter not found or failed — non-blocking
      }
    }
  } catch {
    // pass through
  }

  process.stdout.write(data);
  process.exit(0);
});
