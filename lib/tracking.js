/** Catalina — parse the sections of a tracking.md that `catalina check` reads. */

function sections(text) {
  const out = {};
  const parts = String(text).split(/^## +/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf("\n");
    const head = (nl === -1 ? p : p.slice(0, nl)).trim().toLowerCase();
    out[head] = nl === -1 ? "" : p.slice(nl + 1).trim();
  }
  return out;
}

/** The body of the first section whose heading starts with `name` (case-insensitive), or null. */
function section(text, name) {
  const s = sections(text);
  const key = Object.keys(s).find((k) => k === name.toLowerCase() || k.startsWith(name.toLowerCase() + " "));
  return key === undefined ? null : s[key];
}

/** Premortem items: `- **P1 Scenario** — …` (accepts —, -- or -). */
function premortem(text) {
  const body = section(text, "Premortem");
  if (body === null) return { present: false, trivial: false, ids: [] };
  const trivial = /^_?Trivial:\s*\S/m.test(body);
  const ids = [...body.matchAll(/^- \*\*(P\d+)\b[^*]*\*\*\s*(?:—|--|-)/gm)].map((m) => m[1]);
  return { present: true, trivial, ids };
}

/** True when a section has real content, not just a `_(pending…)_` placeholder. */
function filled(body) {
  if (body === null) return false;
  const stripped = body.replace(/^_\((?:pending|todo)[^)]*\)_\s*$/gim, "").trim();
  return stripped.length > 0;
}

function escalations(text) {
  const body = section(text, "Review History") || "";
  return (body.match(/^- ESCALATED:/gm) || []).length;
}

module.exports = { sections, section, premortem, filled, escalations };
