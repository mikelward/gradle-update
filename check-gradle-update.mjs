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
// And with --verify-upstream, one thing the texts alone cannot give: that
// every new version really is published for every module sharing its key,
// with a POM date outside the cooldown. The fingerprint the publish job
// checks was captured on the SAME machine that later ran the batch's Gradle
// code, so code already compromised within-major could forge a matching
// artifact-and-fingerprint pair naming an hours-old release — defeating
// exactly the window the cooldown exists to provide. Re-asking the
// repositories from this runner is pure metadata over HTTPS, the class of
// work the trust split already allows here, and closes that reach-back.
//
// validateCatalogUpdate is a pure function over the two file texts, exported
// for check-gradle-update.test.js; verifyUpstream is pure but for the
// injected fetcher and clock. The CLI at the bottom is the only part that
// touches git, the filesystem, or the network.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  REPOSITORIES,
  compareVersions,
  fetchModuleVersions,
  fetchVersionDate,
  httpsFetcher,
  isPlainVersion,
  isStable,
  majorOf,
  moduleOf,
  parseCatalog,
  variantOf,
  versionRefOf,
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

// Re-asks the repositories about every change a passing diff consists of.
// Fail closed throughout: a module nothing references, a version no
// repository lists, a repository error, a missing POM date, and a date
// inside the cooldown are all refusals — on this side of the trust split a
// blocked publish costs a rerun, while a guessed pass costs the window a
// compromised release needs to be yanked. The resolve-time check ran
// minutes earlier, so a release that passed the cooldown there only gets
// older; no legitimate batch is refused by re-checking here.
export const verifyUpstream = async (
  newText,
  changes,
  { fetcher, cooldownDays, now = new Date(), repositories = REPOSITORIES },
) => {
  const errors = [];
  const { versions, libraries, plugins } = parseCatalog(newText);
  const modulesByKey = new Map();
  for (const [name, entry, kind] of [
    ...[...libraries].map(([n, e]) => [n, e, "library"]),
    ...[...plugins].map(([n, e]) => [n, e, "plugin"]),
  ]) {
    const ref = versionRefOf(entry);
    if (ref === null || !versions.has(ref)) continue;
    const module = moduleOf(entry, kind);
    if (module === null) continue;
    if (!modulesByKey.has(ref)) modulesByKey.set(ref, []);
    modulesByKey.get(ref).push(module);
  }

  for (const { key, to } of changes) {
    const modules = modulesByKey.get(key);
    if (!modules || modules.length === 0) {
      // The engine only ever moves keys some library or plugin references,
      // so a changed key with no coordinates is not something it produced.
      errors.push(`${key}: no library or plugin references it, so nothing vouches for ${to} upstream`);
      continue;
    }
    for (const module of modules) {
      const coords = `${module.group}:${module.artifact}`;
      const { versions: available, errors: fetchErrors } = await fetchModuleVersions(
        module,
        fetcher,
        repositories,
      );
      if (fetchErrors.length > 0) {
        errors.push(`${key}: could not verify ${coords} (${fetchErrors.join("; ")})`);
        continue;
      }
      const repo = available.get(to);
      if (!repo) {
        errors.push(`${key}: no repository lists ${coords}:${to}`);
        continue;
      }
      // Mirrors decideUpdate's own cooldownDays <= 0 shortcut: existence is
      // still required (the check above), but a caller that disabled the
      // cooldown does not need a date, so a repository that omits
      // Last-Modified (or a transient HEAD failure) must not block an
      // otherwise-valid publish over a check nobody asked for.
      if (cooldownDays <= 0) continue;
      const date = await fetchVersionDate(module, to, repo, fetcher);
      if (date === null) {
        errors.push(`${key}: no publish date for ${coords}:${to}, so the cooldown cannot be verified`);
        continue;
      }
      const ageDays = (now.getTime() - date.getTime()) / 86_400_000;
      if (ageDays < cooldownDays) {
        errors.push(
          `${key}: ${coords}:${to} was published ${ageDays.toFixed(1)} days ago, ` +
            `inside the ${cooldownDays}-day cooldown`,
        );
      }
    }
  }
  return errors;
};

// ---------------------------------------------------------------------------
// CLI: compares the committed catalog (HEAD) with the working copy the
// artifact overlaid, exactly as the publish job sees them.
// ---------------------------------------------------------------------------

const main = async () => {
  let catalog = "gradle/libs.versions.toml";
  let verify = false;
  let cooldownDays = 5;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => inline ?? argv[++i];
    // Named, matching update-versions.mjs's own --catalog: a bare positional
    // would have to reject anything starting with "-" to avoid swallowing a
    // flag typo as a path, which also rejects a canonical repo-relative path
    // that legitimately starts with a hyphen (workflow's own guard permits
    // one). Naming the flag sidesteps the ambiguity entirely.
    if (flag === "--catalog") catalog = value();
    else if (flag === "--verify-upstream") verify = true;
    else if (flag === "--cooldown-days") cooldownDays = Number(value());
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isFinite(cooldownDays) || cooldownDays < 0) {
    throw new Error("--cooldown-days must be a non-negative number");
  }

  const oldText = execFileSync("git", ["show", `HEAD:${catalog}`], { encoding: "utf8" });
  const newText = readFileSync(catalog, "utf8");
  const { ok, errors, changes } = validateCatalogUpdate(oldText, newText);
  if (!ok) {
    for (const e of errors) console.error(`::error::${e}`);
    process.exit(1);
  }
  if (verify) {
    const upstreamErrors = await verifyUpstream(newText, changes, {
      fetcher: httpsFetcher,
      cooldownDays,
    });
    if (upstreamErrors.length > 0) {
      for (const e of upstreamErrors) console.error(`::error::${e}`);
      process.exit(1);
    }
  }
  for (const c of changes) console.log(`${c.key}: ${c.from} -> ${c.to}`);
};

// argv[1] is undefined under `node -e`/`--test` importing this as a module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
