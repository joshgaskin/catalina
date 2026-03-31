#!/usr/bin/env node
/**
 * PreToolUse Hook: Phase-Aware Compaction Advisor
 *
 * Replaces suggest-compact.js with phase-aware detection.
 * Tracks ILR phase transitions (design → implement → witness → retro)
 * and suggests /compact at meaningful moments, not arbitrary counts.
 *
 * Key insight from Marius: context window degradation ("Chinese Whispers")
 * means you want fresh context at phase boundaries, especially before
 * /witness — the same agent that wrote the code should NOT review it
 * with that implementation context still loaded.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// --- Config ---
const COUNT_THRESHOLD = 50;
const COUNT_INTERVAL = 25;

// ILR commands that signal phase transitions
const PHASE_COMMANDS = {
  "/spec": "design",
  "/probe": "design",
  "/capture": "implement",
  "/witness": "witness",
  "/groom": "triage",
  "/observe": null, // doesn't change phase
};

// Transition messages — the WHY matters more than the WHAT
const TRANSITION_MESSAGES = {
  "design->implement": [
    "[Phase] Design → Implementation.",
    "Consider /compact — fresh context prevents the spec from being",
    "reinterpreted through implementation assumptions.",
  ].join("\n"),
  "implement->witness": [
    "[Phase] ⚠️  Implementation → Witness.",
    "/compact is STRONGLY recommended before witnessing.",
    "The agent that wrote the code has inherent bias reviewing its own work.",
    "Feynman needs genuinely fresh eyes — that's the whole point.",
  ].join("\n"),
  "implement->design": [
    "[Phase] Implementation → Design (new issue?).",
    "Consider /compact to clear implementation context.",
  ].join("\n"),
  "witness->implement": [
    "[Phase] Witness → Implementation (fixing failures?).",
    "Consider /compact if switching to a different issue.",
  ].join("\n"),
};

function getStateFile() {
  const sessionId =
    process.env.CLAUDE_SESSION_ID || process.ppid || "default";
  return path.join(os.tmpdir(), `claude-phase-${sessionId}`);
}

function readState() {
  try {
    const raw = fs.readFileSync(getStateFile(), "utf8").trim();

    // Handle migration from old suggest-compact.js format (plain integer)
    const asInt = parseInt(raw, 10);
    if (raw === String(asInt)) {
      return { count: asInt, phase: null, lastCommand: null, lastCommandAt: 0 };
    }

    return JSON.parse(raw);
  } catch {
    return { count: 0, phase: null, lastCommand: null, lastCommandAt: 0 };
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(getStateFile(), JSON.stringify(state));
  } catch {
    // Non-blocking
  }
}

function detectCommand(command) {
  if (!command) return null;
  for (const [cmd, phase] of Object.entries(PHASE_COMMANDS)) {
    // Match commands like: claude '/spec 42' or direct invocations
    if (command.includes(cmd)) return { command: cmd, phase };
  }
  return null;
}

function detectPhaseFromEdits(filePath, currentPhase) {
  if (!filePath) return null;

  // Editing tracking files = design/witness phase
  if (filePath.includes(".claude/tracking/")) {
    if (filePath.includes("verification.jsonl")) return "witness";
    if (filePath.includes("observations.jsonl")) return null; // /observe doesn't change phase
    if (filePath.includes("tracking.md")) return currentPhase; // could be design or capture
  }

  // Editing source files when we were in design = transition to implement
  if (currentPhase === "design" && !filePath.includes(".claude/")) {
    return "implement";
  }

  return null;
}

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (data.length < 1024 * 1024) data += chunk;
});

process.stdin.on("end", () => {
  // Always pass through
  process.stdout.write(data);

  try {
    const input = JSON.parse(data);
    const state = readState();
    state.count = (state.count || 0) + 1;

    const bashCommand = input.tool_input?.command || "";
    const filePath = input.tool_input?.file_path || "";

    // --- Phase detection ---
    let newPhase = null;
    let detectedCommand = null;

    // Check Bash commands for ILR command invocations
    if (bashCommand) {
      const detected = detectCommand(bashCommand);
      if (detected) {
        detectedCommand = detected.command;
        newPhase = detected.phase;
      }
    }

    // Check file edits for implicit phase transitions
    if (!newPhase && filePath) {
      newPhase = detectPhaseFromEdits(filePath, state.phase);
    }

    // --- Transition messaging ---
    if (newPhase && state.phase && newPhase !== state.phase) {
      const transitionKey = `${state.phase}->${newPhase}`;
      const message = TRANSITION_MESSAGES[transitionKey];

      if (message) {
        console.error(`\n${message}\n`);
      }
    }

    // --- Conflict of interest warning ---
    // If we're entering witness phase and there's been no compact since implementation
    if (
      newPhase === "witness" &&
      state.phase === "implement" &&
      state.count - (state.lastCommandAt || 0) > 5
    ) {
      console.error(
        [
          "\n[Phase] ⚠️  WARNING: Witnessing after extended implementation without /compact.",
          "The conversation still carries implementation context and assumptions.",
          "Run /compact first so Feynman gets truly independent verification.\n",
        ].join("\n")
      );
    }

    // --- Update state ---
    if (detectedCommand) {
      state.lastCommand = detectedCommand;
      state.lastCommandAt = state.count;
    }
    if (newPhase) {
      state.phase = newPhase;
    }

    writeState(state);

    // --- Fallback: tool count threshold (same as old suggest-compact.js) ---
    if (state.count === COUNT_THRESHOLD) {
      console.error(
        `[Phase] ${COUNT_THRESHOLD} tool calls — consider /compact if switching phases`
      );
    } else if (
      state.count > COUNT_THRESHOLD &&
      (state.count - COUNT_THRESHOLD) % COUNT_INTERVAL === 0
    ) {
      console.error(
        `[Phase] ${state.count} tool calls — good checkpoint for /compact`
      );
    }
  } catch {
    // Non-blocking — never break the tool call
  }

  process.exit(0);
});
