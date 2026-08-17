#!/usr/bin/env node
// Moves every version in a Gradle version catalog (gradle/libs.versions.toml)
// to the newest stable release WITHIN ITS CURRENT MAJOR, the Gradle analog of
// `npm update --save` under a caret range. Majors stay a deliberate,
// human-initiated migration; anything held back by that rule is reported so
// the weekly PR can say what is waiting.
//
// This is the JVM sibling of npm-update, and it inherits that design's
// division of labor: this script runs in the update job and only ever reads
// Maven METADATA over HTTPS — no dependency code executes while it decides
// anything. The consumer's Gradle checks (which do execute dependency and
// plugin code) run afterwards, and check-versions-update.mjs re-validates the
// diff from a clean context in the publish job.
//
// What "no majors" covers, honestly: the catalog's own entries. Gradle has no
// lockfile in these repos, so a same-major direct bump can still pull a new
// TRANSITIVE major silently — the consumer's own test suite and CI are the
// coverage for that, and the gap is stated in README.md rather than papered
// over.
//
// The cooldown mirrors `.npmrc`'s `min-release-age`: a version younger than
// the window is skipped and the next-newest eligible one considered instead,
// so a compromised release has time to be yanked before an unattended job
// takes it. Per-version publish time comes from the Last-Modified header on
// the version's POM — none of the three repositories serve it in
// maven-metadata.xml, all three serve it on the file.
//
// Everything here is a pure function over parsed text plus an injectable
// fetcher, exported for update-versions.test.js. The CLI at the bottom is the
// only part that touches the filesystem or the network.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Repositories in the order the consumers declare them (settings.gradle.kts:
// google(), mavenCentral(), and the plugin portal for plugin markers).
// Metadata is taken as the UNION across repositories that know the module,
// matching how Gradle resolves a dynamic version, rather than first-hit-wins.
export const REPOSITORIES = [
  "https://dl.google.com/android/maven2",
  "https://repo.maven.apache.org/maven2",
  "https://plugins.gradle.org/m2",
];

// ---------------------------------------------------------------------------
// TOML subset parser — just enough for version catalogs.
//
// A catalog's [versions], [libraries] and [plugins] entries are one line
// each: TOML forbids newlines inside an inline table, so a line-oriented
// parse is sound, not a shortcut. [bundles] arrays can span lines but carry
// no versions, so that section is skipped wholesale.
// ---------------------------------------------------------------------------

// Splits an inline table body on top-level commas, respecting quotes and
// nested braces (rich versions: version = { strictly = "..." }). Both TOML
// string styles are tracked, since a literal-string value ('g:a') may hold
// what a basic-string one may.
const splitInline = (body) => {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (const ch of body) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === "{") {
      depth++;
      current += ch;
    } else if (ch === "}") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
};

// Parses one `key = value` pair from an inline table. Values this cares
// about are strings; a nested inline table comes back parsed under `table`
// so the caller can recognize the longhand version.ref (`version = { ref =
// "x" }`) and classify genuine rich versions (strictly, prefer) as
// unmanaged rather than misread them.
const parseInlinePair = (part) => {
  const m = /^\s*([A-Za-z0-9_."'-]+)\s*=\s*(.*?)\s*$/.exec(part);
  if (!m) return null;
  const key = m[1].replaceAll(/["']/g, "");
  const raw = m[2];
  if (raw.startsWith("{")) return [key, { table: parseInlineTable(raw) }];
  const s = /^(["'])([^"']*)\1$/.exec(raw);
  return s ? [key, s[2]] : [key, { unparsed: raw }];
};

// The balanced { ... } body of an inline table, ignoring anything after the
// matching close brace — a trailing `# comment` would otherwise leave the
// brace inside the body and corrupt the last pair's value.
const inlineBody = (text) => {
  const start = text.indexOf("{");
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  // Unbalanced input: best effort, matching the old behavior.
  return text.trim().replace(/^\{/, "").replace(/\}$/, "");
};

export const parseInlineTable = (text) => {
  const inner = inlineBody(text.trim());
  const entry = {};
  for (const part of splitInline(inner)) {
    const pair = parseInlinePair(part);
    if (pair) entry[pair[0]] = pair[1];
  }
  return entry;
};

// Parses the catalog into { versions, libraries, plugins }, each a map of
// key -> entry. Version entries carry their line number so the writer can
// replace exactly that line. Entries it cannot model (rich versions, ranges)
// are kept with enough shape to be REPORTED as unmanaged — never silently
// dropped, never guessed at.
export const parseCatalog = (text) => {
  const versions = new Map();
  const libraries = new Map();
  const plugins = new Map();
  let section = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    if (stripped === "" || stripped.startsWith("#")) continue;
    // A trailing comment (`[versions] # pins`) and a quoted table name
    // (`["versions"]`) are both valid TOML; missing either would silently
    // skip the whole section.
    const header =
      /^\[\s*(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/.exec(
        stripped,
      );
    if (header) {
      section = header[1] ?? header[2] ?? header[3];
      continue;
    }
    if (section === "versions") {
      // Dots are legal in catalog aliases (`foo.bar = "1.0"`) and so are
      // TOML quoted keys (`"core.ktx" = ...`) — both admitted, unquoted to
      // an opaque string, since Gradle's own parser is what gives the form
      // meaning. A trailing `# comment` and TOML's literal-string form
      // ('1.2.3') are ordinary syntax too and must not turn the entry
      // unmanaged; the rewrite replaces only the quoted value, in its own
      // quote style, so all of it survives an update untouched.
      const m = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=\s*(.*?)\s*$/.exec(stripped);
      if (!m) continue;
      // `\s*` before the comment: TOML does not require a space between a
      // value and its `#`.
      const s = /^(["'])([^"']*)\1(?:\s*#.*)?$/.exec(m[4]);
      versions.set(m[1] ?? m[2] ?? m[3], {
        value: s ? s[2] : null, // null: a rich version or something else
        quote: s ? s[1] : '"',
        line: i,
      });
    } else if (section === "libraries" || section === "plugins") {
      const m = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=\s*(.*?)\s*$/.exec(stripped);
      if (!m) continue;
      const key = m[1] ?? m[2] ?? m[3];
      const raw = m[4];
      const target = section === "libraries" ? libraries : plugins;
      if (raw.startsWith("{")) {
        target.set(key, parseInlineTable(raw));
      } else {
        const s = /^(["'])([^"']*)\1(?:\s*#.*)?$/.exec(raw);
        if (s) target.set(key, { shorthand: s[2] });
      }
    }
    // [bundles] and unknown sections: nothing versioned lives there.
  }
  return { versions, libraries, plugins };
};

// Maven coordinates for a library or plugin entry, or null when the entry
// has none to query (a BOM-managed library with no version of its own still
// HAS coordinates; an entry we cannot parse does not).
export const moduleOf = (entry, kind) => {
  if (entry.shorthand !== undefined) {
    // "group:artifact:version" for libraries, "id:version" for plugins.
    const parts = entry.shorthand.split(":");
    if (kind === "plugin" && parts.length >= 1 && parts[0]) {
      return { group: parts[0], artifact: `${parts[0]}.gradle.plugin` };
    }
    if (kind === "library" && parts.length >= 2) {
      return { group: parts[0], artifact: parts[1] };
    }
    return null;
  }
  if (kind === "plugin") {
    return typeof entry.id === "string"
      ? { group: entry.id, artifact: `${entry.id}.gradle.plugin` }
      : null;
  }
  if (typeof entry.module === "string") {
    const [group, artifact] = entry.module.split(":");
    return group && artifact ? { group, artifact } : null;
  }
  return typeof entry.group === "string" && typeof entry.name === "string"
    ? { group: entry.group, artifact: entry.name }
    : null;
};

// Which [versions] key an entry pins, if any — the dotted shorthand
// (version.ref = "x") or the longhand nested table (version = { ref = "x" }).
// A nested table carrying anything beyond a lone `ref` is a genuine rich
// version and stays unmanaged.
export const versionRefOf = (entry) => {
  if (typeof entry["version.ref"] === "string") return entry["version.ref"];
  const v = entry.version;
  if (
    v !== null &&
    typeof v === "object" &&
    v.table !== undefined &&
    Object.keys(v.table).length === 1 &&
    typeof v.table.ref === "string"
  ) {
    return v.table.ref;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Version ordering and stability.
// ---------------------------------------------------------------------------

// Split on separators AND at digit/letter boundaries, as Maven and Gradle
// do: "1.2.3RC1" is [1, 2, 3, RC, 1], so a qualifier attached without a
// separator is still seen as a qualifier and never mistaken for a platform
// variant.
const BOUNDARY = /(?<=\d)(?=[A-Za-z])|(?<=[A-Za-z])(?=\d)/;

const tokenize = (v) =>
  String(v)
    .split(/[.\-_+]/)
    .flatMap((t) => t.split(BOUNDARY));

// Qualifiers that mark a pre-release. Matched per token so "beta" in
// "4.17-beta-2" fires and a package named like "liberation" cannot. Suffixes
// that mark a VARIANT of a stable release (guava's -android/-jre) are
// deliberately not here. "build" is here for Spring's compound
// "-BUILD-SNAPSHOT": without it the BUILD token survives as a phantom
// variant and the pin can never graduate to a stable release — and a lone
// "-build-N" is a CI build, not a release, so refusing to propose one is
// the right call on its own.
const UNSTABLE_TOKEN =
  /^(alpha|beta|rc|cr|m|milestone|ea|eap|dev|preview|pre|snapshot|snap|nightly|canary|build|a|b)\d*$/i;

// Markers Maven and Gradle rank EQUAL to the bare release ("1.0.final" ==
// "1.0.ga" == "1.0.release" == "1.0"), plus Apache's "incubating" — a
// project-maturity suffix on real releases, held equal here so a pin can
// graduate and a respelling is never an upgrade. These are dropped from
// BOTH the variant and the comparison. "sp" is deliberately NOT here: a
// service pack ranks ABOVE its release, and dropping it would flatten
// "1.0.SP1" into "1.0.1" — it is excluded from the variant only (see
// variantOf), while the comparator keeps it as an ordered qualifier: the
// numeric-outranks-qualifier rule puts "1.0.1" above "1.0.SP1", and the
// run-out rule puts "1.0.SP1" above "1.0".
const RELEASE_MARKER = /^(final|ga|release|incubating)$/i;

// Maturity spellings that are ORDERED (unlike RELEASE_MARKER's synonyms) but
// still name no platform: excluded from the variant, kept in the comparison.
const ORDERED_MATURITY = /^sp$/i;

export const isStable = (v) =>
  tokenize(v).every((t) => t === "" || /^\d+$/.test(t) || !UNSTABLE_TOKEN.test(t));

// First numeric component. Compose-style CalVer ("2026.05.01") gets the year,
// which makes a year rollover a "major" — deliberately conservative: it holds
// the batch back at most once a year and a human takes it from there.
// Kept as a canonical digit string, not a Number: past 2^53 distinct majors
// would collapse to one value and a crossing would pass the equality check.
export const majorOf = (v) => {
  const m = /^(\d+)/.exec(String(v));
  return m ? m[1].replace(/^0+(?=\d)/, "") : null;
};

// Exact comparison of digit strings of any length — shorter (after leading
// zeros) means smaller, equal lengths compare lexically.
const compareNumeric = (x, y) => {
  const a = x.replace(/^0+(?=\d)/, "");
  const b = y.replace(/^0+(?=\d)/, "");
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
};

// Comparison tokens with Maven's trailing-zero trim applied. Maven ranks
// "1.0" equal to "1.0.0" AND "1.0-jre" equal to "1.0.0-jre": its
// trailing-zero trim happens before qualifiers align, so handling zeros
// only when one side runs out misses the suffixed spellings — the
// qualifier meets an inserted zero positionally and "numeric outranks
// qualifier" reports the longer spelling as newer, an artifact swap
// dressed as an upgrade. Trimming up front makes both shapes one case.
//
// The trim works on separator-delimited COMPONENTS, before the
// digit/letter boundary split: only a component that is entirely zeros is
// one of Maven's trailing zeros. A zero split off qualifier text
// ("1.1-0foo") is part of the qualifier's own ordering — Maven ranks
// "1.1-0foo" above "1.1-foo" — so it must survive. One pass, zeros held
// back until something decides the run: a nonzero numeric component keeps
// it, anything else (or the end) drops it. Everything is appended
// per-token — no spreading a buffer into push(), which would throw past
// V8's argument limit (~125k) on an unbounded metadata value.
const compareTokens = (v) => {
  const out = [];
  let zeros = 0;
  for (const c of String(v).split(/[.\-_+]/)) {
    if (/^0+$/.test(c)) {
      zeros++;
    } else if (/^\d+$/.test(c)) {
      for (; zeros > 0; zeros--) out.push("0");
      out.push(c);
    } else {
      zeros = 0; // the zeros trailed their numeric section — dropped
      for (const t of c.split(BOUNDARY)) out.push(t);
    }
  }
  return out.filter((t) => !RELEASE_MARKER.test(t)); // pending zeros met the end — dropped
};

// Total order good enough for release versions: numeric tokens compare
// numerically, alphanumerics lexically, and a version that is a prefix of a
// longer one sorts below it ("1.1" < "1.1.1") — except that a trailing
// pre-release token sorts BELOW the bare prefix ("1.1-rc1" < "1.1"), matching
// Gradle. The stable-only filter upstream means the pre-release arm rarely
// runs, but the comparator should not be wrong when it does.
//
// Release markers are dropped before comparing, because Maven and Gradle
// rank them EQUAL to the bare release: "1.0.0.Final" == "1.0.0.RELEASE" ==
// "1.0.0", so a synonymous spelling must never read as an upgrade — that
// would swap artifacts while reporting an upward bump. ("SP1" keeps its
// digit, so a service pack still ranks above its release.) Trailing zeros
// are equivalent the same way — "1.0" == "1.0.0", "1.0-jre" == "1.0.0-jre"
// — so each version's zero components are trimmed before comparing (see
// compareTokens); the run-out zero checks below remain as a backstop for
// shapes the trim does not produce.
export const compareVersions = (a, b) => {
  const ta = compareTokens(a);
  const tb = compareTokens(b);
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === undefined) {
      if (/^\d+$/.test(y)) {
        if (!/^0+$/.test(y)) return -1;
        continue; // "1.0" vs "1.0.0": the zero pads out equal
      }
      return UNSTABLE_TOKEN.test(y) ? 1 : -1;
    }
    if (y === undefined) {
      if (/^\d+$/.test(x)) {
        if (!/^0+$/.test(x)) return 1;
        continue;
      }
      return UNSTABLE_TOKEN.test(x) ? -1 : 1;
    }
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const c = compareNumeric(x, y);
      if (c !== 0) return c;
    } else if (nx !== ny) {
      return nx ? 1 : -1; // numeric outranks qualifier at the same position
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
};

// A version this tool can manage: a plain dotted release, no ranges, no `+`,
// no rich-version object. Anything else is left alone and reported.
export const isPlainVersion = (v) =>
  typeof v === "string" && /^\d[\dA-Za-z.\-_]*$/.test(v) && !v.includes("+");

// The variant a version's non-numeric tokens spell — guava's "-android" vs
// "-jre", Spring's ".RELEASE". An upgrade must PRESERVE it: from
// 33.4.7-android, both 33.4.8-android and 33.4.8-jre are stable same-major
// upgrades and the lexical comparator would pick -jre, silently switching
// platforms rather than upgrading. Bare versions ("1.19.0") have variant "",
// so a suffixed release never replaces an unsuffixed one either.
//
// Pre-release qualifiers are NOT part of the variant: they mark maturity, not
// platform, so "2.0.0-rc1" has variant "" and a catalog pinned to a
// pre-release can still graduate to its stable release — which the stable
// filter upstream is already steering it toward.
//
// A digit RUN that follows a kept variant token belongs to the variant:
// "jdk8" vs "jdk11" and "arm32" vs "arm64" name different platforms, and
// dropping every numeric would collapse them into one variant and let an
// unattended update switch platforms. Release numerics ("33.4.7") and the
// digits of dropped qualifiers ("rc1", "SP1") follow nothing kept, so they
// stay out — a pre-release pin still graduates, and an SP respelling is
// still no variant.
export const variantOf = (v) => {
  const kept = [];
  let prevKept = false;
  for (const t of tokenize(v)) {
    if (t === "") {
      prevKept = false;
      continue;
    }
    if (/^\d+$/.test(t)) {
      // A digit run extends whatever it followed: kept after a variant
      // token ("jdk8"), dropped after a release numeric or a dropped
      // qualifier's own digits ("rc1", "SP1").
      if (prevKept) kept.push(t);
      continue;
    }
    if (UNSTABLE_TOKEN.test(t) || RELEASE_MARKER.test(t) || ORDERED_MATURITY.test(t)) {
      prevKept = false;
      continue;
    }
    kept.push(t);
    prevKept = true;
  }
  return kept.join("-");
};

// ---------------------------------------------------------------------------
// Repository metadata.
// ---------------------------------------------------------------------------

const groupPath = (group) => group.replaceAll(".", "/");

const parseMetadataVersions = (xml) => {
  const versions = [];
  const re = /<version>([^<]+)<\/version>/g;
  let m;
  while ((m = re.exec(xml)) !== null) versions.push(m[1].trim());
  return versions;
};

// Fetches the union of published versions for a module across the given
// repositories. Returns { versions: Map<version, repo>, errors: [] } — the
// map remembers which repository listed each version so the cooldown check
// can ask the same one for the POM. A 404 is a normal "this repo does not
// carry the module"; anything else is an error worth reporting, because a
// repo that is down must read as "unknown", never as "no versions".
export const fetchModuleVersions = async (module, fetcher, repositories = REPOSITORIES) => {
  const versions = new Map();
  const errors = [];
  for (const repo of repositories) {
    const url = `${repo}/${groupPath(module.group)}/${module.artifact}/maven-metadata.xml`;
    try {
      const res = await fetcher(url);
      if (res.status === 404) continue;
      if (!res.ok) {
        errors.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      for (const v of parseMetadataVersions(await res.text())) {
        if (!versions.has(v)) versions.set(v, repo);
      }
    } catch (e) {
      errors.push(`${url}: ${e.message ?? e}`);
    }
  }
  return { versions, errors };
};

// Publish time of one version, from the Last-Modified header on its POM.
// Returns a Date, or null when the repository does not say — and "does not
// say" is treated by the caller as "too new", the fail-closed direction for a
// cooldown, but per VERSION: an older candidate with a header still wins, so
// one odd artifact cannot freeze a whole dependency. A rejected request (a
// timeout, a transient network failure) is the same null, not an exception:
// an unknowable date must defer one candidate and be reported by the caller,
// never abort the whole batch.
export const fetchVersionDate = async (module, version, repo, fetcher) => {
  const url =
    `${repo}/${groupPath(module.group)}/${module.artifact}/${version}/` +
    `${module.artifact}-${version}.pom`;
  try {
    const res = await fetcher(url, { method: "HEAD" });
    if (!res.ok) return null;
    const header = res.headers.get("last-modified");
    if (!header) return null;
    const date = new Date(header);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// The decision: one version key at a time.
// ---------------------------------------------------------------------------

// How many MISSING-date deferrals the cooldown tolerates before holding the
// key. Candidates rejected for being inside the window don't count against
// this: each such rejection proves the dependency released that recently, so
// the walk is bounded by its real cadence and stops at the first candidate
// old enough — a fixed candidate cap here once meant a daily-releasing
// dependency whose newest five were always cooling could never reach the
// sixth, eligible one. Missing dates are the unbounded case (a repository
// serving no Last-Modified would otherwise be HEAD-polled for every version
// it ever published), so they are what the cap counts.
const MISSING_DATE_LIMIT = 5;

// Decides the new value for one [versions] key given the modules that
// reference it. `availableByModule` is one fetchModuleVersions result per
// module; a candidate must be published for EVERY module sharing the key
// (they move together — that is what sharing a key means).
//
// Returns { to, heldMajor, cooldownSkipped, reasons } where `to` is null when
// the key stays put.
export const decideUpdate = async (
  key,
  current,
  modules,
  availableByModule,
  { cooldownDays, now, versionDate },
) => {
  const reasons = [];
  // Versions listed for every module.
  let shared = [...availableByModule[0].versions.keys()];
  for (const other of availableByModule.slice(1)) {
    shared = shared.filter((v) => other.versions.has(v));
  }

  const currentMajor = majorOf(current);
  const currentVariant = variantOf(current);
  // isPlainVersion first: a candidate the clean-context validator would
  // refuse (build metadata like "1.0.1+1") must never be selected, or the
  // whole batch runs its checks only to fail publication every week.
  const stable = shared.filter(isPlainVersion).filter(isStable);
  const upgrades = stable
    .filter((v) => variantOf(v) === currentVariant)
    .filter((v) => compareVersions(v, current) > 0)
    .sort((a, b) => compareVersions(b, a)); // newest first

  const newestOverall = upgrades[0];
  const inMajor = upgrades.filter((v) => majorOf(v) === currentMajor);
  const heldMajor =
    newestOverall !== undefined && majorOf(newestOverall) !== currentMajor
      ? newestOverall
      : null;

  let cooldownSkipped = 0;
  let missingDates = 0;
  const cutoff = now.getTime() - cooldownDays * 24 * 60 * 60 * 1000;
  for (const candidate of inMajor) {
    if (cooldownDays <= 0) return { to: candidate, heldMajor, cooldownSkipped, reasons };
    if (missingDates >= MISSING_DATE_LIMIT) break;
    // EVERY module sharing the key must have published the candidate outside
    // the window — publication is often staggered across an artifact family,
    // and taking a release that is old for one module but hours old for its
    // sibling would break the cooldown's guarantee for that sibling. Each
    // module's POM is asked in the repository that listed the version for it.
    let eligible = true;
    for (let i = 0; i < modules.length; i++) {
      const module = modules[i];
      const date = await versionDate(module, candidate, availableByModule[i].versions.get(candidate));
      if (date === null) {
        reasons.push(
          `${candidate}: no publish date for ${module.group}:${module.artifact}, treated as too new`,
        );
        missingDates++;
        eligible = false;
        break;
      }
      if (date.getTime() > cutoff) {
        reasons.push(
          `${candidate}: ${module.group}:${module.artifact} published ` +
            `${date.toISOString().slice(0, 10)}, inside the ${cooldownDays}-day cooldown`,
        );
        eligible = false;
        break;
      }
    }
    if (eligible) return { to: candidate, heldMajor, cooldownSkipped, reasons };
    cooldownSkipped++;
  }
  return { to: null, heldMajor, cooldownSkipped, reasons };
};

// ---------------------------------------------------------------------------
// Whole-catalog update.
// ---------------------------------------------------------------------------

// Rewrites exactly the [versions] lines that changed, byte-identical
// everywhere else, so the diff a reviewer reads is the decision and nothing
// but. The line was captured at parse time; the replacement asserts the old
// value is still on it rather than trusting the offset blindly.
export const rewriteVersions = (text, changes) => {
  const lines = text.split("\n");
  for (const { key, from, to, line, quote = '"' } of changes) {
    const old = lines[line];
    const updated = old.replace(`${quote}${from}${quote}`, `${quote}${to}${quote}`);
    const lead = old.trimStart();
    const holdsKey =
      lead.startsWith(key) || lead.startsWith(`"${key}"`) || lead.startsWith(`'${key}'`);
    if (updated === old || !holdsKey) {
      throw new Error(`internal: line ${line + 1} no longer holds ${key} = ${quote}${from}${quote}`);
    }
    lines[line] = updated;
  }
  return lines.join("\n");
};

// Runs the whole update over one catalog text. Pure but for the injected
// effects: `fetcher` for HTTP, `now` for the clock. Returns the new text and
// a report; throws only on internal errors, never on a repository being down
// — that lands in report.errors, and the CLI decides how loud to be.
export const updateCatalog = async (
  text,
  { fetcher, now = new Date(), cooldownDays = 5, repositories = REPOSITORIES },
) => {
  const { versions, libraries, plugins } = parseCatalog(text);

  // key -> [{ module, kind }...] for every entry that pins a catalog version.
  const modulesByKey = new Map();
  const unmanaged = [];
  for (const [name, entry, kind] of [
    ...[...libraries].map(([n, e]) => [n, e, "library"]),
    ...[...plugins].map(([n, e]) => [n, e, "plugin"]),
  ]) {
    const ref = versionRefOf(entry);
    const module = moduleOf(entry, kind);
    if (ref !== null && versions.has(ref)) {
      if (module === null) {
        unmanaged.push(`${kind} ${name}: cannot derive Maven coordinates`);
        continue;
      }
      if (!modulesByKey.has(ref)) modulesByKey.set(ref, []);
      modulesByKey.get(ref).push(module);
    } else if (entry.shorthand !== undefined || entry.version !== undefined) {
      // A literal or rich version outside [versions]: left alone, said aloud.
      unmanaged.push(`${kind} ${name}: version is not a [versions] reference`);
    }
    // No version at all (BOM-managed library): nothing to manage, not a gap.
  }

  const changes = [];
  const held = [];
  const cooldown = [];
  const errors = [];
  for (const [key, { value, quote, line }] of versions) {
    const modules = modulesByKey.get(key);
    if (!modules) {
      // Referenced only from build files (or not at all): no coordinates to
      // query, so it cannot be managed from here.
      unmanaged.push(`version ${key}: no library or plugin references it`);
      continue;
    }
    if (!isPlainVersion(value)) {
      unmanaged.push(`version ${key}: "${value}" is not a plain version`);
      continue;
    }
    const availableByModule = [];
    let failed = false;
    for (const module of modules) {
      const result = await fetchModuleVersions(module, fetcher, repositories);
      errors.push(...result.errors);
      if (result.errors.length > 0 || result.versions.size === 0) {
        // Hold the key on ANY repository error, not only when nothing
        // answered: a partial union can be missing the newest release the
        // erroring repository carries, and "newest stable within the major"
        // is the promise. An empty, error-free result means the coordinates
        // are wrong. Either way: hold this key, report, resolve the rest.
        errors.push(
          result.versions.size === 0 && result.errors.length === 0
            ? `${key}: no versions found for ${module.group}:${module.artifact}`
            : `${key}: held — incomplete metadata for ${module.group}:${module.artifact}` +
              (result.errors.length > 0 ? " (repository errors above)" : ""),
        );
        failed = true;
        break;
      }
      availableByModule.push(result.versions);
    }
    if (failed) continue;

    const decision = await decideUpdate(
      key,
      value,
      modules,
      availableByModule.map((v) => ({ versions: v })),
      {
        cooldownDays,
        now,
        versionDate: (module, version, repo) =>
          fetchVersionDate(module, version, repo, fetcher),
      },
    );
    if (decision.to !== null) {
      changes.push({ key, from: value, to: decision.to, line, quote });
    }
    if (decision.heldMajor !== null) {
      held.push({ key, from: value, newest: decision.heldMajor });
    }
    if (decision.cooldownSkipped > 0) {
      // Reported even when an older candidate was taken instead — "took
      // 1.2.2, 1.2.3 is cooling down" is exactly what the reviewer of the
      // weekly PR wants to know.
      cooldown.push({ key, from: value, to: decision.to, reasons: decision.reasons });
    }
  }

  return {
    text: changes.length > 0 ? rewriteVersions(text, changes) : text,
    changes,
    held,
    cooldown,
    unmanaged,
    errors,
  };
};

// Markdown for the PR body: what moved, what a major is holding, what the
// cooldown deferred, what this tool does not manage. Small and stable so the
// weekly diff of the PR body itself stays readable.
export const reportMarkdown = (report) => {
  const lines = [];
  if (report.changes.length > 0) {
    lines.push("## Updated", "");
    for (const c of report.changes) lines.push(`- \`${c.key}\`: ${c.from} → ${c.to}`);
    lines.push("");
  }
  if (report.held.length > 0) {
    lines.push("## Held back — new major available", "");
    for (const h of report.held) {
      lines.push(`- \`${h.key}\`: ${h.from} stays; ${h.newest} needs a deliberate migration`);
    }
    lines.push("");
  }
  if (report.cooldown.length > 0) {
    lines.push("## Deferred by the release-age cooldown", "");
    for (const c of report.cooldown) {
      lines.push(
        c.to === null
          ? `- \`${c.key}\` stays at ${c.from}:`
          : `- \`${c.key}\` took ${c.to}, newer releases are cooling down:`,
      );
      for (const r of c.reasons) lines.push(`  - ${r}`);
    }
    lines.push("");
  }
  if (report.unmanaged.length > 0) {
    lines.push("## Not managed by this tool", "");
    for (const u of report.unmanaged) lines.push(`- ${u}`);
    lines.push("");
  }
  if (report.errors.length > 0) {
    lines.push("## Repository errors", "");
    for (const e of report.errors) lines.push(`- ${e}`);
    lines.push("");
  }
  if (lines.length === 0) lines.push("No dependency updates available this run.", "");
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

const parseArgs = (argv) => {
  const args = { catalog: "gradle/libs.versions.toml", cooldownDays: 5, markdown: null };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => inline ?? argv[++i];
    if (flag === "--catalog") args.catalog = value();
    else if (flag === "--cooldown-days") args.cooldownDays = Number(value());
    else if (flag === "--markdown") args.markdown = value();
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isFinite(args.cooldownDays) || args.cooldownDays < 0) {
    throw new Error(`--cooldown-days must be a non-negative number`);
  }
  return args;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const text = readFileSync(args.catalog, "utf8");
  const fetcher = (url, init) =>
    fetch(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  const report = await updateCatalog(text, { fetcher, cooldownDays: args.cooldownDays });

  if (report.text !== text) writeFileSync(args.catalog, report.text);
  const markdown = reportMarkdown(report);
  if (args.markdown !== null) writeFileSync(args.markdown, markdown);
  process.stdout.write(markdown + "\n");

  // A repository error is a held update, not a broken run — unless nothing
  // could be decided at all, which would otherwise read as "everything is
  // up to date" forever, in silence.
  if (report.errors.length > 0 && report.changes.length === 0) {
    process.stderr.write(
      "Repository errors and no updates resolved — failing loudly rather than reporting a clean run.\n",
    );
    process.exit(1);
  }
};

// argv[1] is undefined under `node -e`/`--test` importing this as a module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
