// Runs the real engine against fixture catalogs and a stubbed fetcher. The
// suite's failure mode is a false pass — a fixture that stops matching the
// code path it names still goes green — so where a case depends on the stub
// having served something, the test asserts it did.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCatalog,
  versionRefOf,
  parseInlineTable,
  moduleOf,
  isStable,
  majorOf,
  compareVersions,
  isPlainVersion,
  variantOf,
  fetchModuleVersions,
  decideUpdate,
  rewriteVersions,
  updateCatalog,
  reportMarkdown,
} from "./update-versions.mjs";

// ---------------------------------------------------------------------------
// Stub repository: url -> { versions: [...], dates: { version: ISO } } keyed
// by "<group>:<artifact>". Serves maven-metadata.xml GETs and POM HEADs the
// way the real repos do, and counts requests so tests can assert a path ran.
// ---------------------------------------------------------------------------

const REPO = "https://repo.example.com/m2";

const makeFetcher = (modules) => {
  const requests = [];
  const fetcher = async (url, init = {}) => {
    requests.push(url);
    const metadata = /^(.*)\/(.+?)\/maven-metadata\.xml$/.exec(url);
    if (metadata) {
      const path = metadata[1].slice(REPO.length + 1);
      const artifact = metadata[2];
      const key = `${path.replaceAll("/", ".")}:${artifact}`;
      const mod = modules[key];
      if (!mod) return { ok: false, status: 404 };
      const body =
        "<metadata><versioning><versions>" +
        mod.versions.map((v) => `<version>${v}</version>`).join("") +
        "</versions></versioning></metadata>";
      return { ok: true, status: 200, text: async () => body };
    }
    const pom = /^(.*)\/([^/]+)\/([^/]+)\/\2-\3\.pom$/.exec(url);
    if (pom && init.method === "HEAD") {
      const path = pom[1].slice(REPO.length + 1);
      const key = `${path.replaceAll("/", ".")}:${pom[2]}`;
      const date = modules[key]?.dates?.[pom[3]];
      if (!date) return { ok: false, status: 404, headers: { get: () => null } };
      return { ok: true, status: 200, headers: { get: () => date } };
    }
    return { ok: false, status: 404, headers: { get: () => null } };
  };
  return { fetcher, requests };
};

const OLD = "2020-01-01T00:00:00Z"; // far outside any cooldown
const NOW = new Date("2026-08-15T00:00:00Z");

const run = (text, modules, opts = {}) => {
  const { fetcher, requests } = makeFetcher(modules);
  return updateCatalog(text, {
    fetcher,
    now: NOW,
    cooldownDays: 5,
    repositories: [REPO],
    ...opts,
  }).then((report) => ({ report, requests }));
};

// ---------------------------------------------------------------------------
// Parsing.
// ---------------------------------------------------------------------------

test("parseCatalog reads versions, libraries, and plugins", () => {
  const { versions, libraries, plugins } = parseCatalog(
    [
      "[versions]",
      'agp = "9.2.0"',
      'coreKtx = "1.18.0" # trailing comments are ordinary TOML',
      "[libraries]",
      'androidx-core-ktx = { group = "androidx.core", name = "core-ktx", version.ref = "coreKtx" }',
      'compose-ui = { group = "androidx.compose.ui", name = "ui" }',
      "[plugins]",
      'android-application = { id = "com.android.application", version.ref = "agp" }',
      "[bundles]",
      'ui = ["compose-ui",',
      '  "androidx-core-ktx"]',
    ].join("\n"),
  );
  assert.equal(versions.get("agp").value, "9.2.0");
  assert.equal(versions.get("coreKtx").value, "1.18.0"); // the comment does not turn the entry unmanaged
  assert.equal(libraries.get("androidx-core-ktx")["version.ref"], "coreKtx");
  assert.equal(libraries.get("compose-ui")["version.ref"], undefined);
  assert.equal(plugins.get("android-application").id, "com.android.application");
});

test("parseInlineTable handles module shorthand and nested rich versions", () => {
  assert.equal(parseInlineTable('{ module = "g:a", version.ref = "k" }').module, "g:a");
  const rich = parseInlineTable('{ group = "g", name = "a", version = { strictly = "1.0" } }');
  assert.deepEqual(rich.version, { table: { strictly: "1.0" } });
});

test("versionRefOf reads both the shorthand and the lone-ref longhand", () => {
  assert.equal(versionRefOf({ "version.ref": "k" }), "k");
  assert.equal(versionRefOf({ version: { table: { ref: "k" } } }), "k");
  assert.equal(versionRefOf({ version: { table: { strictly: "1.0" } } }), null); // a real rich version stays unmanaged
  assert.equal(versionRefOf({ version: { table: { ref: "k", strictly: "1.0" } } }), null);
});

test("moduleOf derives coordinates from every entry shape", () => {
  assert.deepEqual(moduleOf({ group: "g", name: "a" }, "library"), { group: "g", artifact: "a" });
  assert.deepEqual(moduleOf({ module: "g:a" }, "library"), { group: "g", artifact: "a" });
  assert.deepEqual(moduleOf({ shorthand: "g:a:1.0" }, "library"), { group: "g", artifact: "a" });
  assert.deepEqual(moduleOf({ id: "p.q" }, "plugin"), {
    group: "p.q",
    artifact: "p.q.gradle.plugin",
  });
  assert.equal(moduleOf({ name: "a" }, "library"), null);
});

// ---------------------------------------------------------------------------
// Version rules — both directions each.
// ---------------------------------------------------------------------------

test("isStable rejects pre-releases and keeps stable variants", () => {
  for (const v of ["1.2.3", "2026.05.01", "33.0.0-android", "33.0.0-jre", "1.4", "5.0.0.RELEASE"]) {
    assert.equal(isStable(v), true, v);
  }
  for (const v of [
    "4.17-beta-2",
    "1.0.0-alpha03",
    "2.0-rc1",
    "1.0-M1",
    "1.0.0-SNAPSHOT",
    "9.3.0-dev01",
    "1.2.3-eap",
    "1.2.2-canary01", // androidx ships these weekly
  ]) {
    assert.equal(isStable(v), false, v);
  }
});

test("majorOf takes the first numeric component, as a canonical digit string", () => {
  assert.equal(majorOf("9.2.0"), "9");
  assert.equal(majorOf("2026.05.01"), "2026");
  assert.equal(majorOf("007.1"), "7"); // leading zeros canonicalized so equality means equality
  assert.equal(majorOf("v1.2"), null); // not a plain version; caller reports it
});

test("components past 2^53 keep exact ordering and distinct majors", () => {
  // Number() would collapse these to the same value; a crossing between them
  // must not pass the in-major equality check or read as not-an-upgrade.
  assert.ok(compareVersions("9007199254740993.2", "9007199254740992.1") > 0);
  assert.notEqual(majorOf("9007199254740992.1"), majorOf("9007199254740993.2"));
  assert.equal(compareVersions("1.007", "1.7"), 0); // leading zeros don't order
});

test("compareVersions orders numerically, prefixes below, pre-releases below their base", () => {
  assert.ok(compareVersions("1.10.0", "1.9.0") > 0);
  assert.ok(compareVersions("1.1", "1.1.1") < 0);
  assert.ok(compareVersions("1.1-rc1", "1.1") < 0);
  assert.ok(compareVersions("1.1", "1.1-rc1") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.ok(compareVersions("2026.06.00", "2026.05.01") > 0);
});

test("trailing zero components rank equal — 1.0 is 1.0.0", async () => {
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "1.0"), 0);
  assert.ok(compareVersions("1.0.1", "1.0") > 0);
  assert.ok(compareVersions("1.1-rc1", "1.1.0") < 0); // the prerelease arm survives padding
  // The longer spelling of the same number is not an upgrade.
  const d = await decide("1.0", ["1.0", "1.0.0"]);
  assert.equal(d.to, null);
});

test("trailing zeros rank equal before a preserved qualifier too", async () => {
  // Maven ranks these equal; the run-out padding never fires when the
  // qualifier follows the zeros, so the trim has to happen up front.
  assert.equal(compareVersions("1.0-jre", "1.0.0-jre"), 0);
  assert.equal(compareVersions("1.0.0-jre", "1.0-jre"), 0);
  assert.ok(compareVersions("1.0.1-jre", "1.0-jre") > 0); // a real bump still reads as one
  // The longer spelling of the same suffixed number is not an upgrade.
  const d = await decide("1.0-jre", ["1.0-jre", "1.0.0-jre"]);
  assert.equal(d.to, null);
  // A long zero run stays linear to process and correct at both fates:
  // dropped at the end, kept when a nonzero numeric closes the run — even
  // past V8's ~125k argument limit, which a spread-into-push would throw on.
  const zeros = ".0".repeat(200000);
  assert.equal(compareVersions(`1${zeros}`, "1"), 0);
  assert.ok(compareVersions(`1${zeros}.1`, "1") > 0);
  // A zero attached to qualifier TEXT is not a trailing component: Maven
  // ranks 1.1-0foo above 1.1-foo, so the digit-led qualifier must survive
  // the trim rather than collapse the two spellings into a tie.
  assert.ok(compareVersions("1.1-0foo", "1.1-foo") > 0);
  assert.ok(compareVersions("1.1-foo", "1.1-0foo") < 0);
});

test("an incubating pin graduates — Apache maturity, not platform", async () => {
  const d = await decide("0.5-incubating", ["0.5-incubating", "0.6"]);
  assert.equal(d.to, "0.6");
});

test("release-marker spellings rank equal, never as upgrades of each other", async () => {
  assert.equal(compareVersions("1.0.0.RELEASE", "1.0.0.Final"), 0);
  assert.equal(compareVersions("1.0.0.Final", "1.0.0"), 0);
  assert.ok(compareVersions("1.0.0.SP1", "1.0.0.Final") > 0); // a service pack still outranks its release
  assert.ok(compareVersions("1.0.SP1", "1.0") > 0); // even spelled without the patch component
  assert.ok(compareVersions("1.0.1", "1.0.SP1") > 0); // and the next numeric release outranks the SP
  // From a .Final pin, the .RELEASE synonym of the same number is not an
  // upgrade — proposing it would swap artifacts under a same-version label.
  const d = await decide("1.0.0.Final", ["1.0.0.Final", "1.0.0.RELEASE"]);
  assert.equal(d.to, null);
});

test("isPlainVersion rejects ranges, dynamic versions, and rich objects", () => {
  assert.equal(isPlainVersion("1.2.3"), true);
  assert.equal(isPlainVersion("1.+"), false);
  assert.equal(isPlainVersion("[1.0,2.0)"), false);
  assert.equal(isPlainVersion(null), false);
});

// ---------------------------------------------------------------------------
// Metadata fetching.
// ---------------------------------------------------------------------------

test("fetchModuleVersions unions across repositories and reports non-404 failures", async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.startsWith("https://a/")) {
      return { ok: true, status: 200, text: async () => "<version>1.0</version><version>1.1</version>" };
    }
    if (url.startsWith("https://b/")) return { ok: false, status: 404 };
    return { ok: false, status: 503 };
  };
  const { versions, errors } = await fetchModuleVersions(
    { group: "g.h", artifact: "a" },
    fetcher,
    ["https://a", "https://b", "https://c"],
  );
  assert.equal(calls.length, 3);
  assert.ok(calls[0].includes("/g/h/a/maven-metadata.xml")); // dots became path segments
  assert.deepEqual([...versions.keys()], ["1.0", "1.1"]);
  assert.equal(versions.get("1.0"), "https://a");
  assert.equal(errors.length, 1); // the 503, not the 404
  assert.match(errors[0], /503/);
});

// ---------------------------------------------------------------------------
// The decision.
// ---------------------------------------------------------------------------

const decide = (current, available, { dates = {}, cooldownDays = 5 } = {}) =>
  decideUpdate(
    "k",
    current,
    [{ group: "g", artifact: "a" }],
    [{ versions: new Map(available.map((v) => [v, REPO])) }],
    {
      cooldownDays,
      now: NOW,
      versionDate: async (_m, version) => (dates[version] ? new Date(dates[version]) : new Date(OLD)),
    },
  );

test("variantOf reads the platform suffix and ignores pre-release qualifiers", () => {
  assert.equal(variantOf("33.4.8-android"), "android");
  assert.equal(variantOf("33.4.8-jre"), "jre");
  assert.equal(variantOf("5.0.0.RELEASE"), ""); // release marker ≡ bare, per Maven
  assert.equal(variantOf("6.6.1.Final"), "");
  assert.equal(variantOf("1.19.0"), "");
  assert.equal(variantOf("2.0.0-rc1"), ""); // maturity, not platform
});

test("a pre-release pin graduates to its stable release", async () => {
  const d = await decide("2.0.0-rc1", ["2.0.0-rc1", "2.0.0", "2.0.1"]);
  assert.equal(d.to, "2.0.1");
});

test("a variant's own digits are part of the variant — jdk8 is not jdk11", async () => {
  assert.notEqual(variantOf("1.0-jdk8"), variantOf("1.1-jdk11"));
  assert.equal(variantOf("1.0-jdk8"), variantOf("1.1-jdk8"));
  assert.notEqual(variantOf("2.0-arm32"), variantOf("2.0-arm64"));
  assert.equal(variantOf("1.0.SP1"), ""); // a dropped qualifier's digits stay dropped
  // From -jdk8, the -jdk11 build of a newer version must not win.
  const d = await decide("1.0-jdk8", ["1.0-jdk8", "1.1-jdk8", "1.1-jdk11"]);
  assert.equal(d.to, "1.1-jdk8");
});

test("an upgrade preserves the variant suffix instead of switching platforms", async () => {
  // From -android, the lexically-larger -jre variant must not win; the held
  // major is the -android one too, since -jre majors are not this consumer's.
  const d = await decide("33.4.7-android", [
    "33.4.7-android",
    "33.4.8-android",
    "33.4.8-jre",
    "34.0.0-android",
    "34.0.0-jre",
  ]);
  assert.equal(d.to, "33.4.8-android");
  assert.equal(d.heldMajor, "34.0.0-android");
});

test("a bare version never takes a suffixed release", async () => {
  const d = await decide("1.2.0", ["1.2.0", "1.3.0-android"]);
  assert.equal(d.to, null);
});

test("decideUpdate takes the newest stable in-major upgrade", async () => {
  const d = await decide("1.2.0", ["1.2.0", "1.2.5", "1.3.0", "1.3.0-rc1", "2.0.0"]);
  assert.equal(d.to, "1.3.0");
  assert.equal(d.heldMajor, "2.0.0");
});

test("decideUpdate holds when only majors or pre-releases are newer", async () => {
  const d = await decide("1.3.0", ["1.3.0", "1.4.0-alpha01", "2.0.0"]);
  assert.equal(d.to, null);
  assert.equal(d.heldMajor, "2.0.0");
});

test("decideUpdate steps past versions inside the cooldown to an older eligible one", async () => {
  const d = await decide("1.2.0", ["1.2.0", "1.2.5", "1.3.0"], {
    dates: { "1.3.0": "2026-08-14T00:00:00Z" }, // 1 day old, inside the 5-day window
  });
  assert.equal(d.to, "1.2.5");
  assert.equal(d.cooldownSkipped, 1);
  assert.match(d.reasons[0], /cooldown/);
});

test("a daily-releasing dependency still reaches its first eligible release", async () => {
  // Six stable releases inside/around a 5-day window: the newest five are all
  // cooling, the sixth is eligible. A fixed candidate cap held this key
  // forever; the walk must continue past too-new candidates to the first old
  // enough.
  const versions = ["1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.0.5", "1.0.6"];
  const dates = {
    "1.0.6": "2026-08-15T00:00:00Z",
    "1.0.5": "2026-08-14T00:00:00Z",
    "1.0.4": "2026-08-13T00:00:00Z",
    "1.0.3": "2026-08-12T00:00:00Z",
    "1.0.2": "2026-08-11T00:00:00Z", // five inside the window...
    "1.0.1": "2026-08-01T00:00:00Z", // ...and the sixth well outside it
  };
  const d = await decide("1.0.0", versions, { dates });
  assert.equal(d.to, "1.0.1");
  assert.equal(d.cooldownSkipped, 5);
});

test("missing publish dates stop the walk after a bounded number of deferrals", async () => {
  // Every candidate lacks a date: the walk must give up after the limit
  // rather than HEAD-polling every version the repository ever published.
  const versions = ["1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.0.5", "1.0.6", "1.0.7"];
  let asked = 0;
  const d = await decideUpdate(
    "k",
    "1.0.0",
    [{ group: "g", artifact: "a" }],
    [{ versions: new Map(versions.map((v) => [v, REPO])) }],
    {
      cooldownDays: 5,
      now: NOW,
      versionDate: async () => {
        asked++;
        return null;
      },
    },
  );
  assert.equal(d.to, null);
  assert.equal(asked, 5);
});

test("decideUpdate treats a missing publish date as too new — per version, not per key", async () => {
  const d = await decideUpdate(
    "k",
    "1.2.0",
    [{ group: "g", artifact: "a" }],
    [{ versions: new Map([["1.2.0", REPO], ["1.2.5", REPO], ["1.3.0", REPO]]) }],
    {
      cooldownDays: 5,
      now: NOW,
      versionDate: async (_m, version) => (version === "1.3.0" ? null : new Date(OLD)),
    },
  );
  assert.equal(d.to, "1.2.5"); // the dated older candidate still wins
  assert.match(d.reasons[0], /no publish date/);
});

test("decideUpdate with cooldown 0 never asks for dates", async () => {
  let asked = 0;
  const d = await decideUpdate(
    "k",
    "1.0",
    [{ group: "g", artifact: "a" }],
    [{ versions: new Map([["1.1", REPO]]) }],
    {
      cooldownDays: 0,
      now: NOW,
      versionDate: async () => {
        asked++;
        return null;
      },
    },
  );
  assert.equal(d.to, "1.1");
  assert.equal(asked, 0);
});

test("the cooldown holds for EVERY module sharing a key, not just the first", async () => {
  // 2.11.0 is old for artifact a but published yesterday for artifact b —
  // publication is often staggered across a family. Taking it would break
  // the cooldown guarantee for b, so the batch steps down to 2.10.1.
  const dates = {
    "g:a": { "2.10.1": OLD, "2.11.0": OLD },
    "g:b": { "2.10.1": OLD, "2.11.0": "2026-08-14T00:00:00Z" },
  };
  const versions = new Map([["2.10.0", REPO], ["2.10.1", REPO], ["2.11.0", REPO]]);
  const asked = [];
  const d = await decideUpdate(
    "k",
    "2.10.0",
    [
      { group: "g", artifact: "a" },
      { group: "g", artifact: "b" },
    ],
    [{ versions }, { versions }],
    {
      cooldownDays: 5,
      now: NOW,
      versionDate: async (module, version) => {
        asked.push(`${module.group}:${module.artifact}`);
        return new Date(dates[`${module.group}:${module.artifact}`][version]);
      },
    },
  );
  assert.equal(d.to, "2.10.1");
  assert.ok(asked.includes("g:b")); // the second module's date was actually consulted
  assert.match(d.reasons[0], /g:b/);
});

test("a shared key moves only to a version every module publishes", async () => {
  const d = await decideUpdate(
    "k",
    "2.9.0",
    [
      { group: "g", artifact: "a" },
      { group: "g", artifact: "b" },
    ],
    [
      { versions: new Map([["2.9.0", REPO], ["2.10.0", REPO], ["2.11.0", REPO]]) },
      { versions: new Map([["2.9.0", REPO], ["2.10.0", REPO]]) }, // b lags
    ],
    { cooldownDays: 0, now: NOW, versionDate: async () => new Date(OLD) },
  );
  assert.equal(d.to, "2.10.0");
});

// ---------------------------------------------------------------------------
// Rewriting.
// ---------------------------------------------------------------------------

test("rewriteVersions changes exactly the named lines", () => {
  const text = ['[versions]', 'a = "1.0"', 'b = "1.0"', "", "[libraries]"].join("\n");
  const out = rewriteVersions(text, [{ key: "a", from: "1.0", to: "1.1", line: 1 }]);
  assert.equal(out, ['[versions]', 'a = "1.1"', 'b = "1.0"', "", "[libraries]"].join("\n"));
});

test("rewriteVersions refuses a line that no longer matches", () => {
  const text = ['[versions]', 'a = "1.0"'].join("\n");
  assert.throws(() => rewriteVersions(text, [{ key: "a", from: "9.9", to: "1.1", line: 1 }]));
  assert.throws(() => rewriteVersions(text, [{ key: "b", from: "1.0", to: "1.1", line: 1 }]));
});

// ---------------------------------------------------------------------------
// Whole-catalog runs.
// ---------------------------------------------------------------------------

const CATALOG = [
  "[versions]",
  'coreKtx = "1.18.0"',
  'lifecycle = "2.10.0"',
  'kotlinCompiler = "2.2.20"', // referenced only from build files
  "",
  "[libraries]",
  'androidx-core-ktx = { group = "androidx.core", name = "core-ktx", version.ref = "coreKtx" }',
  'lifecycle-runtime = { group = "androidx.lifecycle", name = "lifecycle-runtime-compose", version.ref = "lifecycle" }',
  'lifecycle-viewmodel = { group = "androidx.lifecycle", name = "lifecycle-viewmodel-compose", version.ref = "lifecycle" }',
  'compose-ui = { group = "androidx.compose.ui", name = "ui" }', // BOM-managed
  'androidsvg = { group = "com.caverock", name = "androidsvg-aar", version = "1.4" }', // literal
  "",
].join("\n");

const CATALOG_MODULES = {
  "androidx.core:core-ktx": {
    versions: ["1.18.0", "1.19.0", "2.0.0"],
    dates: { "1.19.0": OLD },
  },
  "androidx.lifecycle:lifecycle-runtime-compose": {
    versions: ["2.10.0", "2.10.1", "2.11.0"],
    dates: { "2.10.1": OLD, "2.11.0": OLD },
  },
  "androidx.lifecycle:lifecycle-viewmodel-compose": {
    versions: ["2.10.0", "2.10.1"], // lags its sibling
    dates: { "2.10.1": OLD },
  },
};

test("updateCatalog updates in-major, honors shared keys, reports the rest", async () => {
  const { report, requests } = await run(CATALOG, CATALOG_MODULES);
  assert.ok(requests.length > 0);
  assert.deepEqual(
    report.changes.map((c) => [c.key, c.to]),
    [
      ["coreKtx", "1.19.0"],
      ["lifecycle", "2.10.1"], // 2.11.0 exists for one module only
    ],
  );
  assert.deepEqual(report.held.map((h) => [h.key, h.newest]), [["coreKtx", "2.0.0"]]);
  assert.ok(report.unmanaged.some((u) => u.includes("kotlinCompiler")));
  assert.ok(report.unmanaged.some((u) => u.includes("androidsvg")));
  assert.ok(!report.unmanaged.some((u) => u.includes("compose-ui"))); // BOM-managed is not a gap
  assert.equal(report.errors.length, 0);

  // The rewrite touched exactly the two version lines.
  const diff = report.text
    .split("\n")
    .filter((line, i) => line !== CATALOG.split("\n")[i]);
  assert.deepEqual(diff, ['coreKtx = "1.19.0"', 'lifecycle = "2.10.1"']);
});

test("updateCatalog leaves the text untouched when nothing moves", async () => {
  const { report } = await run(CATALOG, {
    "androidx.core:core-ktx": { versions: ["1.18.0"] },
    "androidx.lifecycle:lifecycle-runtime-compose": { versions: ["2.10.0"] },
    "androidx.lifecycle:lifecycle-viewmodel-compose": { versions: ["2.10.0"] },
  });
  assert.equal(report.text, CATALOG);
  assert.equal(report.changes.length, 0);
});

test("a module no repository lists is held and reported, not dropped", async () => {
  const { report } = await run(CATALOG, {
    ...CATALOG_MODULES,
    "androidx.core:core-ktx": undefined,
  });
  assert.ok(!report.changes.some((c) => c.key === "coreKtx"));
  assert.ok(report.errors.some((e) => e.includes("core-ktx")));
  // The rest of the batch still resolves.
  assert.ok(report.changes.some((c) => c.key === "lifecycle"));
});

test("a partial repository outage holds the affected key and resolves the rest", async () => {
  // Repo A answers for both modules; repo B 503s only for core-ktx. The
  // union for core-ktx would be missing whatever B carries, so that key is
  // held — while the lifecycle keys, whose fetches were clean, still move.
  const { fetcher: base } = (() => {
    const modules = {
      "androidx.core:core-ktx": { versions: ["1.18.0", "1.19.0"], dates: { "1.19.0": OLD } },
      "androidx.lifecycle:lifecycle-runtime-compose": {
        versions: ["2.10.0", "2.10.1"],
        dates: { "2.10.1": OLD },
      },
      "androidx.lifecycle:lifecycle-viewmodel-compose": {
        versions: ["2.10.0", "2.10.1"],
        dates: { "2.10.1": OLD },
      },
    };
    return makeFetcher(modules);
  })();
  const fetcher = async (url, init) =>
    url.includes("core-ktx/maven-metadata.xml") && url.startsWith("https://b/")
      ? { ok: false, status: 503 }
      : base(url.replace("https://b", REPO), init);
  const report = await updateCatalog(CATALOG, {
    fetcher,
    now: NOW,
    cooldownDays: 5,
    repositories: [REPO, "https://b"],
  });
  assert.ok(!report.changes.some((c) => c.key === "coreKtx"));
  assert.ok(report.errors.some((e) => e.includes("incomplete metadata")));
  assert.ok(report.changes.some((c) => c.key === "lifecycle")); // clean keys still resolve
});

test("a repository outage reads as errors, never as an empty version list", async () => {
  const fetcher = async () => ({ ok: false, status: 503 });
  const report = await updateCatalog(CATALOG, {
    fetcher,
    now: NOW,
    cooldownDays: 5,
    repositories: [REPO],
  });
  assert.equal(report.changes.length, 0);
  assert.ok(report.errors.length > 0);
});

test("plugins resolve through their marker artifact", async () => {
  const text = [
    "[versions]",
    'roborazzi = "1.63.0"',
    "[plugins]",
    'roborazzi = { id = "io.github.takahirom.roborazzi", version.ref = "roborazzi" }',
  ].join("\n");
  const { report, requests } = await run(text, {
    "io.github.takahirom.roborazzi:io.github.takahirom.roborazzi.gradle.plugin": {
      versions: ["1.63.0", "1.72.0"],
      dates: { "1.72.0": OLD },
    },
  });
  assert.ok(requests.some((u) => u.includes("io.github.takahirom.roborazzi.gradle.plugin")));
  assert.deepEqual(report.changes.map((c) => [c.key, c.to]), [["roborazzi", "1.72.0"]]);
});

test("dotted catalog aliases are parsed and updated like any other", async () => {
  const text = [
    "[versions]",
    'foo.bar = "1.0.0"',
    "[libraries]",
    'foo.bar = { module = "g:a", version.ref = "foo.bar" }',
  ].join("\n");
  const { report } = await run(text, {
    "g:a": { versions: ["1.0.0", "1.1.0"], dates: { "1.1.0": OLD } },
  });
  assert.deepEqual(report.changes.map((c) => [c.key, c.to]), [["foo.bar", "1.1.0"]]);
  assert.ok(report.text.includes('foo.bar = "1.1.0"'));
  assert.equal(report.unmanaged.length, 0); // parsed, not silently skipped
});

test("reportMarkdown covers every section and the empty run", () => {
  const md = reportMarkdown({
    changes: [{ key: "a", from: "1.0", to: "1.1" }],
    held: [{ key: "b", from: "1.0", newest: "2.0" }],
    cooldown: [{ key: "c", from: "1.0", to: null, reasons: ["1.1: inside the window"] }],
    unmanaged: ["version d: no library or plugin references it"],
    errors: ["https://repo/x: HTTP 503"],
  });
  for (const expected of ["## Updated", "## Held back", "## Deferred", "## Not managed", "## Repository errors"]) {
    assert.ok(md.includes(expected), expected);
  }
  assert.equal(
    reportMarkdown({ changes: [], held: [], cooldown: [], unmanaged: [], errors: [] }).trim(),
    "No dependency updates available this run.",
  );
});

test("a rejected date request defers the candidate instead of aborting the run", async () => {
  const { fetchVersionDate } = await import("./update-versions.mjs");
  const date = await fetchVersionDate(
    { group: "g", artifact: "a" },
    "1.1.0",
    REPO,
    async () => {
      throw new Error("network timeout");
    },
  );
  assert.equal(date, null); // the caller reports it and steps to the next candidate
});

test("a commented version entry is updated and keeps its comment", async () => {
  const text = [
    "[versions]",
    'kotlin = "2.2.0" # pinned for compatibility',
    "[libraries]",
    'lib = { module = "g:a", version.ref = "kotlin" }',
  ].join("\n");
  const { report } = await run(text, {
    "g:a": { versions: ["2.2.0", "2.2.1"], dates: { "2.2.1": OLD } },
  });
  assert.deepEqual(report.changes.map((c) => [c.key, c.to]), [["kotlin", "2.2.1"]]);
  assert.ok(report.text.includes('kotlin = "2.2.1" # pinned for compatibility'));
  assert.equal(report.unmanaged.length, 0);
});

test("an inline table with a trailing comment still yields its version.ref", async () => {
  const text = [
    "[versions]",
    'v = "1.0.0"',
    "[libraries]",
    'lib = { module = "g:a", version.ref = "v" } # keep in sync with the BOM',
  ].join("\n");
  const { report } = await run(text, {
    "g:a": { versions: ["1.0.0", "1.1.0"], dates: { "1.1.0": OLD } },
  });
  assert.deepEqual(report.changes.map((c) => [c.key, c.to]), [["v", "1.1.0"]]);
  assert.ok(!report.unmanaged.some((u) => u.includes("no library or plugin references")));
});

test("TOML literal strings are parsed and rewritten in their own quote style", async () => {
  const text = [
    "[versions]",
    "v = '1.0.0'",
    "[libraries]",
    "lib = { module = 'g:a', version.ref = 'v' }",
  ].join("\n");
  const { report } = await run(text, {
    "g:a": { versions: ["1.0.0", "1.1.0"], dates: { "1.1.0": OLD } },
  });
  assert.deepEqual(report.changes.map((c) => [c.key, c.to]), [["v", "1.1.0"]]);
  assert.ok(report.text.includes("v = '1.1.0'")); // quote style preserved
  assert.equal(report.unmanaged.length, 0);
});

test("quoted catalog aliases participate in resolution", async () => {
  const text = [
    "[versions]",
    '"core.ktx" = "1.18.0"',
    "[libraries]",
    '"androidx.core" = { module = "androidx.core:core-ktx", version = { ref = "core.ktx" } }',
  ].join("\n");
  const { report } = await run(text, {
    "androidx.core:core-ktx": { versions: ["1.18.0", "1.19.0"], dates: { "1.19.0": OLD } },
  });
  assert.deepEqual(report.changes.map((c) => [c.key, c.to]), [["core.ktx", "1.19.0"]]);
  assert.ok(report.text.includes('"core.ktx" = "1.19.0"')); // quoted key preserved
  assert.equal(report.unmanaged.length, 0);
});

test("a commented section header still opens its section", async () => {
  const text = [
    "[versions] # dependency pins",
    'v = "1.0.0"',
    "[libraries] # everything the app links",
    'lib = { module = "g:a", version.ref = "v" }',
  ].join("\n");
  const { report } = await run(text, {
    "g:a": { versions: ["1.0.0", "1.1.0"], dates: { "1.1.0": OLD } },
  });
  assert.deepEqual(report.changes.map((c) => [c.key, c.to]), [["v", "1.1.0"]]);
});

test("a qualifier attached without a separator is a pre-release, not a variant", async () => {
  assert.equal(isStable("1.2.3RC1"), false);
  assert.equal(variantOf("1.2.3RC1"), "");
  const d = await decide("1.2.3RC1", ["1.2.3RC1", "1.2.3", "1.2.4"]);
  assert.equal(d.to, "1.2.4"); // the pin graduates instead of being stuck on the RC
});

test("a quoted section header still opens its section", async () => {
  const text = [
    '["versions"]',
    'v = "1.0.0"',
    '["libraries"]',
    'lib = { module = "g:a", version.ref = "v" }',
  ].join("\n");
  const { report } = await run(text, {
    "g:a": { versions: ["1.0.0", "1.1.0"], dates: { "1.1.0": OLD } },
  });
  assert.deepEqual(report.changes.map((c) => [c.key, c.to]), [["v", "1.1.0"]]);
});

test("a candidate with build metadata is never selected — the validator would refuse it", async () => {
  const held = await decide("1.0.0", ["1.0.0", "1.0.1+1"]);
  assert.equal(held.to, null);
  const both = await decide("1.0.0", ["1.0.0", "1.0.1+1", "1.0.1"]);
  assert.equal(both.to, "1.0.1");
});

test("a canary pin graduates instead of chasing newer canaries", async () => {
  const d = await decide("1.2.2-canary01", ["1.2.2-canary01", "1.2.3-canary02", "1.2.3"]);
  assert.equal(d.to, "1.2.3");
});

test("a CR pin graduates to Final — release markers are maturity, not variant", async () => {
  const d = await decide("6.6.0.CR1", ["6.6.0.CR1", "6.6.0.Final", "6.6.1.Final"]);
  assert.equal(d.to, "6.6.1.Final");
});

test("a .RELEASE line upgrades within itself", async () => {
  const d = await decide("1.0.0.RELEASE", ["1.0.0.RELEASE", "1.0.1.RELEASE"]);
  assert.equal(d.to, "1.0.1.RELEASE");
});

test("a service-pack pin moves on — SP is maturity, not variant", async () => {
  // 1.0.1.Final and 1.0.1 are the same version to Maven; the comparator
  // prefers the marked spelling, and either would be a correct pick.
  const d = await decide("1.0.0.SP1", ["1.0.0.SP1", "1.0.1.Final", "1.0.1"]);
  assert.equal(d.to, "1.0.1.Final");
});

test("a BUILD-SNAPSHOT pin graduates — the compound qualifier is no variant", async () => {
  const d = await decide("1.0.0-BUILD-SNAPSHOT", ["1.0.0-BUILD-SNAPSHOT", "1.0.0", "1.0.1"]);
  assert.equal(d.to, "1.0.1");
});

test("a comment with no space before the hash still parses", async () => {
  const text = [
    "[versions]",
    'v = "1.0.0"# pinned',
    "[libraries]",
    'lib = { module = "g:a", version.ref = "v" }',
  ].join("\n");
  const { report } = await run(text, {
    "g:a": { versions: ["1.0.0", "1.1.0"], dates: { "1.1.0": OLD } },
  });
  assert.deepEqual(report.changes.map((c) => [c.key, c.to]), [["v", "1.1.0"]]);
  assert.ok(report.text.includes('v = "1.1.0"# pinned'));
});
