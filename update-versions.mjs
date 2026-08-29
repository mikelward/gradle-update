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
// plugin code) run afterwards, and check-gradle-update.mjs re-validates the
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

// ---------------------------------------------------------------------------
// Maven's ComparableVersion, ported line for line from maven-artifact 3.9.10
// (org.apache.maven.artifact.versioning.ComparableVersion). Every earlier
// attempt to PARAPHRASE its rules — three of them, each verified against a
// different oracle case and each wrong on the next — is why this is now a
// transcription rather than a reading: the parser builds the same nested
// item tree (numbers, qualifier strings, dash-opened sublists), normalize
// removes null items scanning back from each list's tail WITHOUT stopping
// at nested sublists, and comparison uses Maven's item-type ordering
// (number > sublist > qualifier at the same position). The port was
// cross-checked against the real class running locally, including a fuzz
// pass; see the tests.
//
// Deliberate deviations, each a product decision and each conservative:
// - The extended pre-release set (ea, eap, dev, preview, pre, snap,
//   nightly, canary, build) ranks BELOW the release like snapshot does.
//   Maven ranks unknown qualifiers above it, which would strand a catalog
//   pinned to "1.0-eap1" forever: its stable "1.0" would read as a
//   downgrade and never be proposed.
// - "incubating" ranks EQUAL to the release (Maven: above it), so an
//   Apache pin can graduate and a respelling is never an upgrade.
// - "_" and "+" parse as dashes. Maven reads them as qualifier text;
//   catalogs do not use them, and a separator reading is the sane one for
//   an input that somehow does ("+"' is already refused by
//   isPlainVersion).
const QUALIFIERS = ["alpha", "beta", "milestone", "rc", "snapshot", "", "sp"];
const QUALIFIER_ALIASES = { ga: "", final: "", release: "", incubating: "", cr: "rc" };
// Everything isStable refuses must also RANK below the release, or a
// catalog pinned to such a version can never graduate: its stable spelling
// would read as a downgrade. Lone "a"/"b"/"m" are here for that reason —
// Maven expands them to alpha/beta/milestone only when digits follow, and
// ranks the lone spellings above the release as unknown qualifiers.
const EXTRA_UNSTABLE = new Set([
  "ea", "eap", "dev", "preview", "pre", "snap", "nightly", "canary", "build",
  "a", "b", "m",
]);
const RELEASE_INDEX = String(QUALIFIERS.indexOf("")); // "5"

// A lexically comparable key for a qualifier: known qualifiers order by
// index, unknown ones lexically above every known one ("7-..."), and the
// extended pre-release set between snapshot ("4") and the release ("5").
const comparableQualifier = (q) => {
  const i = QUALIFIERS.indexOf(q);
  if (i !== -1) return String(i);
  if (EXTRA_UNSTABLE.has(q)) return `4-${q}`;
  return `${QUALIFIERS.length}-${q}`;
};

// Items: a number is {n: canonicalDigitString}, a qualifier {q: string},
// a sublist a plain array. Null items compare equal to a missing position.
const numItem = (s) => ({ n: s.replace(/^0+(?=\d)/, "") });
const strItem = (s, followedByDigit) => {
  if (followedByDigit && s.length === 1) {
    if (s === "a") s = "alpha";
    else if (s === "b") s = "beta";
    else if (s === "m") s = "milestone";
  }
  return { q: QUALIFIER_ALIASES[s] ?? s };
};
const isNullItem = (item) =>
  Array.isArray(item)
    ? item.length === 0
    : item.n !== undefined
      ? /^0+$/.test(item.n)
      : comparableQualifier(item.q) === RELEASE_INDEX;

// Maven's ListItem.normalize: walk back from the tail removing null items,
// stop at the first non-null SCALAR — but keep walking past a non-null
// sublist, which is how the zero leaves "1.1-0-jre" ([1,1,[[jre]]]) while
// staying in "1.0.1".
const normalizeList = (list) => {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (isNullItem(item)) list.splice(i, 1);
    else if (!Array.isArray(item)) break;
  }
};

// Maven's parseVersion: '.' adds to the current list, '-' opens a sublist,
// and a digit/letter transition acts as '-' — with the extra twist that a
// qualifier arriving via '.' or at the end ALSO opens a sublist first
// ("treat .X as -X"), while one arriving mid-list via letters-then-digit
// splits into qualifier + nested digits.
const parseMavenVersion = (version) => {
  const v = String(version).toLowerCase();
  const root = [];
  const stack = [root];
  let list = root;
  let isDigit = false;
  let start = 0;
  const openSublist = () => {
    const sub = [];
    list.push(sub);
    stack.push(sub);
    list = sub;
  };
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === ".") {
      list.push(i === start ? numItem("0") : parseFlush(v, start, i, isDigit));
      start = i + 1;
    } else if (c === "-" || c === "_" || c === "+") {
      list.push(i === start ? numItem("0") : parseFlush(v, start, i, isDigit));
      start = i + 1;
      openSublist();
    } else if (c >= "0" && c <= "9") {
      if (!isDigit && i > start) {
        if (list.length > 0) openSublist();
        list.push(strItem(v.slice(start, i), true));
        start = i;
        openSublist();
      }
      isDigit = true;
    } else {
      if (isDigit && i > start) {
        list.push(numItem(v.slice(start, i)));
        start = i;
        openSublist();
      }
      isDigit = false;
    }
  }
  if (v.length > start) {
    if (!isDigit && list.length > 0) openSublist();
    list.push(parseFlush(v, start, v.length, isDigit));
  }
  while (stack.length > 0) normalizeList(stack.pop());
  return root;
};
const parseFlush = (v, start, end, isDigit) =>
  isDigit ? numItem(v.slice(start, end)) : strItem(v.slice(start, end), false);

// A scalar item against a run-out position: a number counts as newer
// unless zero; a qualifier decides by its rank against the release
// ("1-rc" < "1", "1-jre" > "1").
const scalarVsNull = (item) => {
  if (item.n !== undefined) return /^0+$/.test(item.n) ? 0 : 1;
  const c = comparableQualifier(item.q);
  return c < RELEASE_INDEX ? -1 : c > RELEASE_INDEX ? 1 : 0;
};

// Maven's Item.compareTo across the three item kinds, null standing in for
// a run-out position. Type order at the same position: number > sublist >
// qualifier ("1.1 > 1-1 > 1-sp"). Iterative with an explicit frame stack:
// nesting depth tracks the input's dash count, so a recursive walk would
// overflow the call stack on an adversarial "1-1-1-…" spelling in
// repository metadata. A list against a run-out position compares every
// item to null (MNG-6964), which is a walk against the empty list.
const compareItems = (l0, r0) => {
  const frames = [{ l: l0, r: r0, i: 0 }];
  while (frames.length > 0) {
    const f = frames[frames.length - 1];
    if (f.i >= f.l.length && f.i >= f.r.length) {
      frames.pop();
      continue;
    }
    const li = f.i < f.l.length ? f.l[f.i] : null;
    const ri = f.i < f.r.length ? f.r[f.i] : null;
    f.i++;
    if (li === null && ri === null) continue;
    if (li === null || ri === null) {
      const present = li ?? ri;
      const sign = li === null ? -1 : 1; // invert when the left ran out
      if (Array.isArray(present)) {
        frames.push(li === null ? { l: [], r: present, i: 0 } : { l: present, r: [], i: 0 });
        continue;
      }
      const c = sign * scalarVsNull(present);
      if (c !== 0) return c;
      continue;
    }
    const lList = Array.isArray(li);
    const rList = Array.isArray(ri);
    if (lList && rList) {
      frames.push({ l: li, r: ri, i: 0 });
      continue;
    }
    if (lList) return ri.n !== undefined ? -1 : 1; // number > list > qualifier
    if (rList) return li.n !== undefined ? 1 : -1;
    if (li.n !== undefined && ri.n !== undefined) {
      const c = compareNumeric(li.n, ri.n);
      if (c !== 0) return c;
      continue;
    }
    if (li.n !== undefined) return 1;
    if (ri.n !== undefined) return -1;
    const a = comparableQualifier(li.q);
    const b = comparableQualifier(ri.q);
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
};

export const compareVersions = (a, b) =>
  compareItems(parseMavenVersion(a), parseMavenVersion(b));

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
    // Replace only in the value half of the line: a key whose quoted NAME
    // equals the old version string (`"1.0" = "1.0"`) would otherwise get its
    // key renamed and its value left behind. No `=` on the line leaves the
    // text unchanged and lands in the internal-error throw below.
    const eq = old.indexOf("=");
    const head = eq === -1 ? old : old.slice(0, eq + 1);
    const tail = eq === -1 ? "" : old.slice(eq + 1);
    const updated = head + tail.replace(`${quote}${from}${quote}`, `${quote}${to}${quote}`);
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
    } else if (ref !== null) {
      // A version.ref with no [versions] entry. Gradle refuses such a catalog
      // outright, but "never silently dropped" is the contract here too.
      unmanaged.push(`${kind} ${name}: version.ref "${ref}" has no [versions] entry`);
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
      changes.push({ key, from: value, to: decision.to, line, quote, modules });
    }
    if (decision.heldMajor !== null) {
      held.push({ key, from: value, newest: decision.heldMajor, modules });
    }
    if (decision.cooldownSkipped > 0) {
      // Reported even when an older candidate was taken instead — "took
      // 1.2.2, 1.2.3 is cooling down" is exactly what the reviewer of the
      // weekly PR wants to know.
      cooldown.push({ key, from: value, to: decision.to, reasons: decision.reasons, modules });
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
// weekly diff of the PR body itself stays readable. Each entry names the
// Maven coordinates its key pins — the catalog alias alone doesn't tell the
// reviewer WHAT moved, and a shared key legitimately pins several modules.
const moduleNames = (modules) =>
  (modules ?? []).map((m) => `${m.group}:${m.artifact}`).join(", ");

// ---------------------------------------------------------------------------
// Pins the catalog cannot see.
// ---------------------------------------------------------------------------

// A Gradle build or settings script can pin a plugin version inline —
// `id("com.example.thing") version "1.0.0"` — where the catalog never sees it.
// The engine cannot move such a pin, and until now the consumer got no signal
// that it had been left behind: exactly the silent skip this tool refuses
// everywhere else. So the scripts are read as TEXT and every literal pin is
// reported under "Not managed".
//
// Reading, not running. This stays on the safe side of the trust line the
// two-job split draws (see the header): it is a file read that decides
// nothing and rewrites nothing, so no dependency or plugin code executes.
//
// A raw string is a legal argument too — `id("""x""") version """1.0"""` is
// valid Kotlin — so the triple forms are tried BEFORE the single character.
// Matching the first quote of a triple as the whole delimiter reported that
// pin as `""x""` at version `"`: not noise but a WRONG entry, misnaming a pin
// the engine can plainly see. Triple quotes now behave the same in both roles
// they play here — a string whose contents are masked, and a delimiter around
// an argument.
//
// Deliberately narrow — it finds a literal version and nothing else. An
// `alias(libs.plugins.x)` has no literal to find because the catalog already
// owns it, and a version built from a variable is not a pin this tool could
// move anyway. Covers the Kotlin DSL (`id("x") version "y"`), both Groovy
// spellings (`id 'x' version 'y'`, `id('x').version('y')`), and Gradle's
// Kotlin-DSL shorthand (`kotlin("jvm") version "y"`), which names the same
// plugin through a different keyword and would otherwise stay invisible —
// the failure this scan exists to prevent.
// One complete string literal, in any spelling Gradle accepts. Written as an
// alternation of WHOLE literals rather than a lazy run between two
// delimiters, because a lazy run backtracks across its own closing quote
// when the rest of the pattern fails to match: `id("java")` followed by
// `id("com.example.real") version "1.2"` matched from the first `id`, took
// everything up to the second literal as one corrupted id, and swallowed the
// real pin with it. A missed pin is the failure this whole scan exists to
// prevent, so the shape rules it out instead of guarding against it.
//
// The single-quoted forms stop at a newline as well as at their delimiter:
// neither Gradle spelling lets an ordinary literal span lines, so crossing
// one is always the runaway case, never a real declaration.
//
// The triple-quoted forms DO span lines, so a newline cannot bound them — they
// are bounded by their own closing triple instead, written as "any character
// that is not a quote, or a quote not beginning one". A lazy run looked
// equivalent and was not: it backtracks past its own closing delimiter when
// the rest of the pattern fails, so `id("""java""")` ahead of a real
// declaration produced one corrupted id spanning both and swallowed the pin —
// the same runaway this alternation was written to rule out, surviving in the
// two branches that could still cross themselves.
const LITERAL = String.raw`(?:"""(?:[^"]|"(?!""))*"""|'''(?:[^']|'(?!''))*'''|"[^"\n]*"|'[^'\n]*')`;

// Strips whichever delimiter a literal actually carries.
const unquote = (literal) =>
  literal.startsWith(`"""`) || literal.startsWith(`'''`)
    ? literal.slice(3, -3)
    : literal.slice(1, -1);

// The version operand is OPTIONAL, and that is the point: what marks a pin is
// the `version` keyword, not the shape of what follows it. Gradle accepts a
// literal, a name (`version pluginVersion`), a catalog accessor, and any other
// expression down to `.version(["1.2"][0])`; a declaration matched only by the
// shapes this pattern happened to enumerate produced NO entry at all for the
// rest, which is the silent skip this scan exists to prevent. Enumerating
// operand shapes has no more of an end to it than enumerating operators did,
// so the pattern stops trying: it captures a literal where there is one and
// reports the plugin with no version where there is not.
// An id argument that is not a literal. `id(pluginId)` and
// `id(providers.gradleProperty("suffix").get())` are both declarations Gradle
// resolves, and requiring a literal here produced NO entry for either — the
// same silent skip as the version side, one argument over. Balanced to two
// levels of nesting, which covers a property lookup and its `.get()`; a regex
// cannot balance arbitrarily, so that limit is stated rather than pretended
// away.
//
// Line breaks are allowed inside it, because a chained call split over several
// lines is ordinary Kotlin formatting and excluding them silently dropped such
// a declaration. It still never crosses a `)`, so it cannot run from one
// declaration into the next.
const NESTED_ARG = String.raw`(?:[^()]|\((?:[^()]|\([^()]*\))*\))*`;

// The operands on BOTH sides are now shapes this pattern stops enumerating.
// What marks a pin is the pair of keywords — `id`/`kotlin` and `version` — not
// what sits between or after them; a literal is captured where there is one so
// its value can be printed, and anything else reports the pin without that
// value rather than omitting the pin. Enumerating operand shapes has no more of
// an end to it than enumerating operators did.
const PLUGIN_PIN = new RegExp(
  String.raw`\b(id|kotlin)\s*` +
    // Parenthesized: a literal, or any other expression.
    `(?:\\(\\s*(?:(${LITERAL})|(${NESTED_ARG}))\\s*\\)` +
    // Groovy's bare spelling, `id 'x' version 'y'`, which has no parentheses
    // and so cannot carry a non-literal argument unambiguously.
    `|(${LITERAL}))` +
    String.raw`\s*\.?\s*version\b\s*\(?\s*` +
    `(${LITERAL})?`,
  "g",
);

// A `$` opening a template — `${…}` or `$name`. A real plugin id or version is
// dotted alphanumerics, so a `$` in one is always interpolation, whichever
// spelling the literal uses.
const INTERPOLATION = /\$[{A-Za-z_]/;

// `kotlin("jvm")` is Gradle's shorthand for this prefix plus the argument.
const KOTLIN_PLUGIN_PREFIX = "org.jetbrains.kotlin.";

// Strips comments so a commented-out pin is never reported as a live one, and
// records which offsets of the result sit INSIDE a string literal.
//
// Both halves are the same problem — knowing what is code and what is not —
// so they share one pass. Quote-aware stripping is why a naive strip does not
// cut `uri("https://example.com")` at its `//`; the string mask is why
// `println('id("com.example.foo") version "1.2.3"')` is not reported as a pin
// it plainly is not. What matters is the position of the KEYWORD: in a real
// declaration `id` sits in code and its arguments are the quoted parts, while
// in that `println` the keyword itself is inside the string.
//
// Positions are marked, not blanked, because the arguments a real declaration
// carries are string literals too — blanking them would leave nothing to
// match.
//
// Quoted, triple-quoted and escaped forms only. Groovy's slashy (`/.../`) and
// dollar-slashy (`$/.../$`) literals are NOT recognized, deliberately: no
// consumer is a Groovy build, `/` is ambiguous with division so a rule for it
// would mis-split ordinary arithmetic, and the cost of the gap is one noise
// line in a PR body rather than a pin nobody sees. That trade only holds
// while it stays that way round — a Groovy consumer, or any sign of the gap
// hiding a real pin, is the reason to revisit it.
export const scanScript = (text, { nestedBlockComments = false } = {}) => {
  let out = "";
  const inString = [];
  let quote = null;
  let i = 0;
  const emit = (chunk, masked) => {
    out += chunk;
    for (let k = 0; k < chunk.length; k += 1) inString.push(masked);
  };
  const tripleAt = (at) => {
    const c = text[at];
    if (c !== '"' && c !== "'") return null;
    return text[at + 1] === c && text[at + 2] === c ? c.repeat(3) : null;
  };
  while (i < text.length) {
    const c = text[i];
    if (quote !== null) {
      // A triple-quoted string is raw: no escapes, and it ends only at its
      // own closing triple. Handling it as three single quotes flipped the
      // quote parity whenever the body held an odd number of them, which
      // marked the REAL code after it as string content and lost the pins in
      // it -- a missed pin, which this repo ranks as the worse failure.
      if (quote.length === 3) {
        if (text.startsWith(quote, i)) {
          emit(quote, true);
          i += 3;
          quote = null;
          continue;
        }
        emit(c, true);
        i += 1;
        continue;
      }
      if (c === "\\") {
        emit(c + (text[i + 1] ?? ""), true);
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      emit(c, true);
      i += 1;
      continue;
    }
    const triple = tripleAt(i);
    if (triple !== null) {
      quote = triple;
      // The opening delimiter is code; what follows it is not.
      emit(triple, false);
      i += 3;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      // The opening delimiter is code; what follows it is not.
      emit(c, false);
      i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      // Kotlin nests block comments; Groovy and Java do not, closing at the
      // FIRST `*/`. So the caller says which language this is rather than the
      // scanner guessing: nesting a Groovy comment would run past its real end
      // and swallow live code, which costs a missed pin — the worse failure of
      // the two. Not nesting a Kotlin one leaves the tail of an outer comment
      // read as code, which costs a spurious line.
      let depth = 1;
      while (i < text.length && depth > 0) {
        if (nestedBlockComments && text[i] === "/" && text[i + 1] === "*") {
          depth += 1;
          i += 2;
          continue;
        }
        if (text[i] === "*" && text[i + 1] === "/") {
          depth -= 1;
          i += 2;
          continue;
        }
        i += 1;
      }
      // A separator, so `a/* c */b` does not become the token `ab`.
      emit(" ", false);
      continue;
    }
    emit(c, false);
    i += 1;
  }
  return { text: out, inString };
};

// Kept as its own export because the comment behavior is worth asserting on
// its own; the mask is what `scanPluginPins` needs.
export const stripScriptComments = (text, options) => scanScript(text, options).text;

// True when the literal ending at `end` is the WHOLE version expression, not
// one operand of a larger one. `.version("1." + minor)`, its method spelling
// `.version("1.".plus(minor))`, and Groovy's `.version("1" * 2)` all report a
// fragment otherwise — `1.`, `1.`, `1` — each a plain version by the
// predicate below, so each sails straight through it as if it were pinned.
//
// A whitelist of what may FOLLOW a finished literal, not a blacklist of
// operators: naming operators one at a time (`+`, then `.`, then `*`) is
// evidence that set has no end. Anything not on this list is an operator
// continuing the expression, so the version is withheld. Comments are already
// stripped to a space by scanScript, so they cannot appear here.
//
// Words are handled by naming the ones that CANNOT end an expression, not the
// ones that can, because only the first of those two sets is closed. What may
// follow a version is `apply`, the next declaration's `id` / `kotlin` /
// `alias`, or a bare core-plugin accessor — and an accessor is any identifier
// Gradle publishes (`java`, `application`, `war`, `signing`, …), so listing
// them was a whitelist that could never be complete, and it reported a real
// literal version as non-literal the moment one appeared. Word OPERATORS are
// language keywords, which is a set that does not grow with the DSL: `in`,
// `is`, `as`, `instanceof`. Naming those and terminating on everything else
// keeps `.version("1" in [...] ? ... : ...)` from reporting the fragment `1`
// while letting an accessor end a declaration.
//
// A line ending is not a terminator either, and skipping newlines with the
// rest of the whitespace is the reason: an expression continues across one
// freely, so `.version("1."` with `+ "2")` on the next line is the version 1.2
// Gradle resolves. Every real terminator survives the skip — a closing brace
// or the next declaration's keyword is simply found one line further on.
const ENDS_EXPRESSION = /[)\]},;]|[A-Za-z_$]/y;
const WORD_OPERATOR = /(?:in|is|as|instanceof)\b/y;

const isWholeExpression = (code, end) => {
  let i = end;
  while (i < code.length && /\s/.test(code[i])) i += 1;
  // End of file finishes the expression as surely as a bracket does.
  if (i >= code.length) return true;
  WORD_OPERATOR.lastIndex = i;
  if (WORD_OPERATOR.test(code)) return false;
  ENDS_EXPRESSION.lastIndex = i;
  return ENDS_EXPRESSION.test(code);
};

// Every distinct plugin pin in one script, in source order. `version` is null
// where the declaration does not pin a literal — see below.
// Every `plugins { … }` block's interior, as [start, end) offsets into the
// comment-stripped text.
//
// This is the context a plugin declaration actually lives in, and scoping the
// scan to it is what stops the pattern joining two unrelated statements. The
// operands on both sides are deliberately permissive — that is what stopped
// the shape enumeration — and the cost was that an ordinary `id(...)` call in
// one statement and an ordinary `version` in the next could complete a match
// between them and report a plugin nobody declared. Excluding one spelling at
// a time (`version =`, then `version.toString()`, …) is the same open-ended
// enumeration seen from the other end; the block boundary ends the class,
// because outside a `plugins` block there is no declaration to find.
//
// Braces inside string literals do not count, which is why this runs over the
// mask rather than the raw text. An unclosed block runs to end of file — the
// permissive direction, since a truncated script should not silently hide the
// declarations it does contain.
const pluginBlocks = (code, inString) => {
  const blocks = [];
  // `plugins {`. Groovy also accepts `plugins({ … })`, and its bare
  // `id pluginId version "1.2"` takes a non-literal id the parenthesized form
  // already handles — both unmodelled, with the reason in README.md: every
  // consumer is a Kotlin script, and Groovy's optional parentheses admit more
  // spellings of one declaration than a pattern should chase.
  const opener = /\bplugins\s*\{/g;
  for (const match of code.matchAll(opener)) {
    if (inString[match.index]) continue;
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < code.length && depth > 0) {
      if (!inString[i]) {
        if (code[i] === "{") depth += 1;
        else if (code[i] === "}") depth -= 1;
      }
      i += 1;
    }
    blocks.push([start, depth === 0 ? i - 1 : code.length]);
  }
  return blocks;
};

export const scanPluginPins = (text, options) => {
  const { text: code, inString } = scanScript(text, options);
  const blocks = pluginBlocks(code, inString);
  const pins = [];
  const seen = new Set();
  for (const match of code.matchAll(PLUGIN_PIN)) {
    // A declaration's keyword is code. The same characters inside a string
    // literal are data — a message, a generated-script template — and
    // reporting those would put a plugin nobody declared in the weekly PR.
    if (inString[match.index]) continue;
    // And it is only a declaration inside a `plugins { … }` block.
    if (!blocks.some(([from, to]) => match.index >= from && match.index < to)) continue;
    const keyword = match[1];
    // Groups 2 and 4 are the literal spellings, 3 the computed one.
    const idLiteral = match[2] ?? match[4];
    // A computed id keeps its source text so a reader can find the
    // declaration, but collapsed onto one line — a chain split over three
    // lines would otherwise put raw newlines in the middle of a report line.
    const name =
      idLiteral === undefined
        ? match[3].trim().replace(/\s+/g, " ")
        : unquote(idLiteral);
    // A declaration with nothing at all between the parentheses is not one.
    if (idLiteral === undefined && name === "") continue;
    // An id that is an expression, or a literal carrying a template, resolves
    // at configuration time — so the source text is not the plugin's id.
    // Carried on the pin so the reported line can say so: printing it as the
    // id names a plugin that does not exist, and a wrong entry is worse than a
    // missing or a spurious one.
    const computedId = idLiteral === undefined || INTERPOLATION.test(name);
    const id = keyword === "kotlin" ? KOTLIN_PLUGIN_PREFIX + name : name;
    // A quoted token is not automatically a pinned version. `version
    // "$pluginVersion"` is a Kotlin template and `.version("1." + minor)` a
    // concatenation; reporting either verbatim names a version that is not
    // pinned anywhere, which is worse than saying nothing about it. Reusing
    // isPlainVersion is deliberate — it is the same predicate the catalog
    // path applies to a `[versions]` entry, so both halves of this tool agree
    // on what counts as a literal.
    const operand = match[5];
    const literal = operand === undefined ? null : unquote(operand);
    const pinned =
      literal !== null &&
      isPlainVersion(literal) &&
      isWholeExpression(code, match.index + match[0].length);
    // Still reported: the pin is outside the catalog either way, and that is
    // the fact the section exists to surface. Only the value is withheld.
    const version = pinned ? literal : null;
    // The same plugin is routinely pinned once and applied in several blocks;
    // report the pin, not each mention of it.
    const key = `${id}\u0000${version ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pins.push({ id, version, computedId });
  }
  return pins;
};

// One "Not managed" line for a pin the scan found outside the catalog.
//
// Two things are withheld rather than guessed, and each is withheld because
// printing it would name something that does not exist — a wrong entry, which
// this repo ranks below both a missing and a spurious one:
//
//   - a version that is not a literal (`version pluginVersion`, `"1." + minor`)
//   - an id built by interpolation, which resolves at configuration time
//
// The pin is reported either way. Being outside the catalog is the fact the
// section exists to surface, and it is true whether or not the value can be
// read.
export const unmanagedPinLine = (pin, file) => {
  const subject = pin.computedId
    ? `plugin with a computed id \`${pin.id}\``
    : `plugin ${pin.id}`;
  return pin.version === null
    ? `${subject}: pinned in ${file} with a non-literal version, outside the catalog`
    : `${subject}: pinned "${pin.version}" in ${file}, outside the catalog`;
};

export const reportMarkdown = (report) => {
  const lines = [];
  if (report.changes.length > 0) {
    lines.push("## Updated", "");
    for (const c of report.changes) {
      lines.push(`- \`${c.key}\` (${moduleNames(c.modules)}): ${c.from} → ${c.to}`);
    }
    lines.push("");
  }
  if (report.held.length > 0) {
    lines.push("## Held back — new major available", "");
    for (const h of report.held) {
      lines.push(
        `- \`${h.key}\` (${moduleNames(h.modules)}): ${h.from} stays; ${h.newest} needs a deliberate migration`,
      );
    }
    lines.push("");
  }
  if (report.cooldown.length > 0) {
    lines.push("## Deferred by the release-age cooldown", "");
    for (const c of report.cooldown) {
      lines.push(
        c.to === null
          ? `- \`${c.key}\` (${moduleNames(c.modules)}) stays at ${c.from}:`
          : `- \`${c.key}\` (${moduleNames(c.modules)}) took ${c.to}, newer releases are cooling down:`,
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
  // The root scripts a plugin version can be pinned in. Module scripts are not
  // scanned by default — no consumer pins there today, and walking the tree
  // would read files this tool has no other business in — so `--scan` takes
  // the whole list when one does.
  //
  // Both language variants are listed, and a repository carrying BOTH would
  // have the ignored one's pins reported alongside the live one's. Not
  // resolved here on purpose: which variant Gradle selects is a version-
  // dependent detail, and picking the wrong one turns a spurious line into a
  // WRONG line naming the file that does not run — the worse failure. A
  // repository with a stale duplicate root script is already in a state
  // Gradle itself warns about; `--scan` names the live one explicitly.
  //
  // The conventional filenames, which is all a default can be: a settings
  // script may rename the root build script (`rootProject.buildFileName`), and
  // resolving that would mean evaluating the settings script — the one thing
  // the trust split says this side of the line must not do. `--scan` names the
  // real file where a consumer has renamed it; the limit is in README.md
  // rather than papered over with a guess.
  const args = {
    catalog: "gradle/libs.versions.toml",
    cooldownDays: 5,
    markdown: null,
    scan: ["settings.gradle.kts", "settings.gradle", "build.gradle.kts", "build.gradle"],
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => inline ?? argv[++i];
    if (flag === "--catalog") args.catalog = value();
    else if (flag === "--cooldown-days") args.cooldownDays = Number(value());
    else if (flag === "--markdown") args.markdown = value();
    else if (flag === "--scan") args.scan = value().split(",").filter((f) => f !== "");
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isFinite(args.cooldownDays) || args.cooldownDays < 0) {
    throw new Error(`--cooldown-days must be a non-negative number`);
  }
  return args;
};

// Redirect chains this fetcher will still follow before giving up — real
// repository redirects (a CDN, a mirror) are one hop, not a chain deep
// enough to matter; the cap is a loop backstop, not a policy.
const MAX_REDIRECTS = 10;

// The one fetcher anything in this repository uses against a repository.
// Repositories are free to redirect (mirrors, CDNs) but never off HTTPS —
// and every HOP has to be checked, not just the final URL: `redirect:
// "follow"` resolves the whole chain internally, so an https -> http ->
// https(attacker) chain reaches the caller as an ordinary https response,
// `res.url` naming only the last, innocent-looking hop. The intermediate
// http leg is exactly where an on-path attacker sits to rewrite the
// redirect target and forge the metadata or Last-Modified date the
// cooldown stands on. `redirect: "manual"` surfaces each hop so its own
// scheme can be checked before it is ever followed.
export const httpsFetcher = async (url, init) => {
  let current = url;
  for (let hop = 0; ; hop++) {
    if (new URL(current).protocol !== "https:") {
      throw new Error(`redirected off https: ${url} -> ${current}`);
    }
    const res = await fetch(current, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status < 300 || res.status >= 400 || !res.headers.get("location")) return res;
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`too many redirects: ${url} -> ${current} (stopped at ${hop})`);
    }
    current = new URL(res.headers.get("location"), current).href;
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const text = readFileSync(args.catalog, "utf8");
  const report = await updateCatalog(text, { fetcher: httpsFetcher, cooldownDays: args.cooldownDays });

  if (report.text !== text) writeFileSync(args.catalog, report.text);

  // Plugin versions pinned in a build script instead of the catalog. The
  // engine cannot move them; naming them is the difference between a gap the
  // consumer can see and one it cannot. An absent script is not a pin — a
  // consumer has `settings.gradle.kts` or `settings.gradle`, never both, and
  // may have no root build script at all.
  //
  // This finds DECLARATIONS. A version applied by resolution strategy
  // (`resolutionStrategy { eachPlugin { useVersion("1.2.3") } }`) pins a plugin
  // with no declaration anywhere, so nothing here can see it; that is a
  // separate mechanism to teach the scan deliberately if a consumer adopts one,
  // not a shape to widen this pattern toward. Recorded in README.md.
  for (const file of args.scan) {
    let script;
    try {
      script = readFileSync(file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    // Only a `.kts` script is Kotlin, and only Kotlin nests block comments.
    for (const pin of scanPluginPins(script, { nestedBlockComments: file.endsWith(".kts") })) {
      report.unmanaged.push(unmanagedPinLine(pin, file));
    }
  }

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
