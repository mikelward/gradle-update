#!/usr/bin/env node
// Validates the diff the weekly dependency update produced, from the publish
// job — a runner that ran no Gradle build and no dependency or plugin code.
// The sibling of npm-update's check-dependency-update.mjs, and the same
// reasoning applies: everything the update job asserted about the catalog, it
// asserted on a machine where the updated dependencies' own code had already
// run (the Gradle checks execute plugins and library code), so the assertion
// that gates the push has to be re-derived somewhere that code never ran.
//
// What it enforces, purely from the two texts:
//   - the only lines that differ are `key = "version"` lines in [versions]
//   - no line was added or removed anywhere in the file
//   - every change keeps the key and moves the version UP within its major,
//     to a stable release
//
// Everything here is a pure function over the two file texts, exported for
// check-versions-update.test.js. The CLI at the bottom is the only part that
// touches git or the filesystem.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  compareVersions,
  isPlainVersion,
  isStable,
  majorOf,
  variantOf,
} from "./update-versions.mjs";

// Parses a line as a [versions] entry: `key = "value"` (either TOML string
// style), optionally followed by a trailing `# comment` — the engine parses
// and updates commented and literal-string entries, so the validator must
// admit the same shapes, dotted keys included. Quote style and comment are
// returned so a change to either is refused: the engine replaces only the
// version between the original quotes.
const versionLine = (line) => {
  const m =
    /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=\s*(["'])([^"']*)\4\s*(#.*)?$/.exec(
      line.trim(),
    );
  if (!m) return null;
  return { key: m[1] ?? m[2] ?? m[3], quote: m[4], version: m[5], comment: m[6] ?? "" };
};

// True while the line index sits inside the [versions] table of `lines`.
const versionsSpan = (lines) => {
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    // Trailing comments and quoted table names are valid TOML on headers —
    // same tolerance as the engine's parser, or a commented or quoted
    // [versions] header would hide the span.
    const header =
      /^\[\s*(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/.exec(
        lines[i].trim(),
      );
    if (!header) continue;
    if ((header[1] ?? header[2] ?? header[3]) === "versions") start = i;
    else if (start !== -1 && i > start && end === lines.length) end = i;
  }
  return { start, end };
};

// Compares old and new catalog text. Returns { ok, errors, changes } where
// changes is the list a passing diff consists of. Never throws on content —
// every rule lands in errors so the workflow can print all of them.
export const validateCatalogUpdate = (oldText, newText) => {
  const errors = [];
  const changes = [];
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  if (oldLines.length !== newLines.length) {
    // Line-by-line comparison below would misalign and blame the wrong
    // lines, so stop on the structural rule alone.
    return {
      ok: false,
      errors: [
        `the update added or removed lines (${oldLines.length} before, ${newLines.length} after); ` +
          "the weekly batch may only change version strings in place",
      ],
      changes: [],
    };
  }

  const span = versionsSpan(oldLines);
  if (span.start === -1) {
    return { ok: false, errors: ["no [versions] table in the old catalog"], changes: [] };
  }

  for (let i = 0; i < oldLines.length; i++) {
    if (oldLines[i] === newLines[i]) continue;
    const at = `line ${i + 1}`;
    if (i <= span.start || i >= span.end) {
      errors.push(`${at}: changed outside the [versions] table`);
      continue;
    }
    const before = versionLine(oldLines[i]);
    const after = versionLine(newLines[i]);
    if (!before || !after) {
      errors.push(`${at}: not a plain \`key = "version"\` change`);
      continue;
    }
    if (before.key !== after.key) {
      errors.push(`${at}: key changed from ${before.key} to ${after.key}`);
      continue;
    }
    if (before.comment !== after.comment) {
      // The engine replaces only the quoted value, so a comment that moved
      // alongside a version bump is an edit this batch could not have made.
      errors.push(`${at}: ${before.key}: the trailing comment changed`);
      continue;
    }
    if (before.quote !== after.quote) {
      // Same reasoning: the engine keeps each entry's own quote style.
      errors.push(`${at}: ${before.key}: the quote style changed`);
      continue;
    }
    if (!isPlainVersion(before.version) || !isPlainVersion(after.version)) {
      errors.push(`${at}: ${before.key}: "${before.version}" -> "${after.version}" is not a plain version bump`);
      continue;
    }
    if (!isStable(after.version)) {
      errors.push(`${at}: ${before.key}: ${after.version} is a pre-release`);
      continue;
    }
    if (majorOf(after.version) !== majorOf(before.version)) {
      errors.push(
        `${at}: ${before.key}: ${before.version} -> ${after.version} crosses a major; ` +
          "majors are a deliberate migration, not a weekly batch",
      );
      continue;
    }
    if (variantOf(after.version) !== variantOf(before.version)) {
      errors.push(
        `${at}: ${before.key}: ${before.version} -> ${after.version} switches the ` +
          "variant suffix; an upgrade must preserve it (guava's -android vs -jre)",
      );
      continue;
    }
    if (compareVersions(after.version, before.version) <= 0) {
      errors.push(`${at}: ${before.key}: ${before.version} -> ${after.version} is not an upgrade`);
      continue;
    }
    changes.push({ key: before.key, from: before.version, to: after.version });
  }

  if (errors.length === 0 && changes.length === 0) {
    // The workflow only publishes when something moved; an identical file
    // here means the wrong artifact landed on this runner.
    errors.push("the catalog is unchanged — nothing to publish");
  }
  return { ok: errors.length === 0, errors, changes };
};

// ---------------------------------------------------------------------------
// CLI: compares the committed catalog (HEAD) with the working copy the
// artifact overlaid, exactly as the publish job sees them.
// ---------------------------------------------------------------------------

const main = () => {
  const catalog = process.argv[2] ?? "gradle/libs.versions.toml";
  const oldText = execFileSync("git", ["show", `HEAD:${catalog}`], { encoding: "utf8" });
  const newText = readFileSync(catalog, "utf8");
  const { ok, errors, changes } = validateCatalogUpdate(oldText, newText);
  if (!ok) {
    for (const e of errors) console.error(`::error::${e}`);
    process.exit(1);
  }
  for (const c of changes) console.log(`${c.key}: ${c.from} -> ${c.to}`);
};

// argv[1] is undefined under `node -e`/`--test` importing this as a module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
