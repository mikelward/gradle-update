// Runs the real engine against fixture catalogs and a stubbed fetcher. The
// suite's failure mode is a false pass — a fixture that stops matching the
// code path it names still goes green — so where a case depends on the stub
// having served something, the test asserts it did.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanPluginPins,
  scanScript,
  stripScriptComments,
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
  httpsFetcher,
  unmanagedPinLine,
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

test("every pre-release spelling ranks below its release — pins can graduate", () => {
  // Anything isStable refuses must also compare below the bare release,
  // or a catalog pinned to it would read its stable spelling as a
  // downgrade and stay stranded forever. Both the bare word and the
  // numbered form, since the comparator aliases some words only when
  // digits follow.
  for (const q of ["alpha", "beta", "rc", "cr", "m", "milestone", "ea", "eap", "dev",
                   "preview", "pre", "snapshot", "snap", "nightly", "canary", "build", "a", "b"]) {
    assert.ok(compareVersions("1.0", `1.0-${q}`) > 0, q);
    assert.ok(compareVersions("1.0", `1.0-${q}1`) > 0, `${q}1`);
  }
});

test("dashed sublists order below numerics — no flattening downgrades", async () => {
  // The P1 the flat model earned: flattening [1,[1]] against [1,0,2] read
  // 1.0-1 as newer than 1.0.2, a silent downgrade path. Maven ranks a
  // sublist below a numeric at the same position.
  assert.ok(compareVersions("1.0-1", "1.0.2") < 0);
  assert.ok(compareVersions("1.0.2", "1.0-1") > 0);
  // Nesting depth is real ordering, not spelling: jre8's digits sit one
  // list deeper than jre.8's, and Maven ranks the deeper one lower.
  assert.ok(compareVersions("1.1-jre8", "1.1-jre.8") < 0);
  const d = await decide("1.0.2", ["1.0.2", "1.0-1"]);
  assert.equal(d.to, null); // never proposed as an upgrade
});

test("dashed zero segments follow Maven's sublist rules", () => {
  // Every case here was checked against Maven's own ComparableVersion
  // (maven-artifact 3.9.10) — as was the whole comparator, which is a
  // line-for-line port of that class, fuzz-diffed against it over 20,000
  // random pairs with zero mismatches. A dash opens a sublist; an
  // all-zero sublist vanishes at the tail but holds its place
  // mid-version, where Maven ranks the kept nesting above a bare
  // qualifier.
  assert.ok(compareVersions("1.1-0-jre", "1.1-jre") > 0);
  assert.ok(compareVersions("1.1-jre", "1.1-0-jre") < 0);
  assert.equal(compareVersions("1.1-0", "1.1"), 0);
  assert.equal(compareVersions("1.0-0.0", "1.0"), 0);
  assert.ok(compareVersions("1.1-0.0-jre", "1.1-jre") > 0);
  assert.equal(compareVersions("1.1-2.0-jre", "1.1-2-jre"), 0); // a nonzero sublist still trims its own tail
  assert.ok(compareVersions("1-final-jre", "1-jre") > 0); // a marker-only sublist holds its place too
  // Qualifier text opens a sublist whatever precedes it: dot, dash, or
  // nothing — and the numeric section trims its zeros at that boundary.
  assert.equal(compareVersions("1.0.x", "1.0-x"), 0);
  assert.equal(compareVersions("1.0.0foo", "1-foo"), 0);
  assert.equal(compareVersions("1.1.x0", "1.1.x"), 0);
  // A mid-section marker is not trailing: Maven ranks 1.0.Final.1 BELOW
  // 1.0.1 (the numeric outranks the marker's sublist), which a global
  // marker filter got backwards.
  assert.ok(compareVersions("1.0.Final.1", "1.0.1") < 0);
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

test("rewriteVersions moves the value, not a key named like the old version", () => {
  // A first-occurrence replace over the whole line would rename the KEY here
  // and leave the version behind — refused downstream, but a weekly red run.
  const text = ['[versions]', '"1.0" = "1.0"'].join("\n");
  const out = rewriteVersions(text, [{ key: "1.0", from: "1.0", to: "1.1", line: 1 }]);
  assert.equal(out, ['[versions]', '"1.0" = "1.1"'].join("\n"));
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
  const lifecycle = report.changes.find((c) => c.key === "lifecycle");
  assert.ok(lifecycle); // clean keys still resolve
  // Each change names the modules its key pins, for the PR-body report.
  assert.ok(lifecycle.modules.some((m) => `${m.group}:${m.artifact}`.includes("lifecycle")));
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

test("a version.ref with no [versions] entry is reported, not dropped", async () => {
  // Gradle refuses such a catalog outright, but "never silently dropped" is
  // the report's contract even for shapes that should not exist.
  const text = [
    "[versions]",
    'real = "1.0"',
    "[libraries]",
    'a = { group = "g", name = "a", version.ref = "ghost" }',
  ].join("\n");
  const { report } = await run(text, {});
  assert.ok(report.unmanaged.some((u) => u.includes('version.ref "ghost"')));
});

test("reportMarkdown covers every section and the empty run", () => {
  const md = reportMarkdown({
    changes: [{ key: "a", from: "1.0", to: "1.1", modules: [{ group: "g", artifact: "x" }] }],
    held: [
      {
        key: "b",
        from: "1.0",
        newest: "2.0",
        modules: [
          { group: "g", artifact: "y" },
          { group: "g", artifact: "z" },
        ],
      },
    ],
    cooldown: [
      {
        key: "c",
        from: "1.0",
        to: null,
        reasons: ["1.1: inside the window"],
        modules: [{ group: "g", artifact: "w" }],
      },
    ],
    unmanaged: ["version d: no library or plugin references it"],
    errors: ["https://repo/x: HTTP 503"],
  });
  for (const expected of ["## Updated", "## Held back", "## Deferred", "## Not managed", "## Repository errors"]) {
    assert.ok(md.includes(expected), expected);
  }
  // The Maven coordinates ride each entry — the catalog alias alone doesn't
  // say what moved, and a shared key names every module it pins.
  assert.ok(md.includes("- `a` (g:x): 1.0 → 1.1"), md);
  assert.ok(md.includes("- `b` (g:y, g:z): 1.0 stays; 2.0 needs a deliberate migration"), md);
  assert.ok(md.includes("- `c` (g:w) stays at 1.0:"), md);
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

// ---------------------------------------------------------------------------
// httpsFetcher: every hop of a redirect chain has to be HTTPS, not just the
// final one — `redirect: "follow"` would resolve the whole chain internally
// and report only the last URL, hiding an intermediate HTTP hop where an
// on-path attacker can rewrite the redirect target.
// ---------------------------------------------------------------------------

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
};

test("httpsFetcher passes through a plain https response", async () => {
  const res = await withFetch(
    async (url) => ({ status: 200, url, headers: { get: () => null } }),
    () => httpsFetcher("https://repo.example.com/x"),
  );
  assert.equal(res.status, 200);
});

test("httpsFetcher follows an all-https redirect chain", async () => {
  const seen = [];
  const res = await withFetch(async (url) => {
    seen.push(url);
    if (url === "https://repo.example.com/a") {
      return { status: 302, headers: { get: (h) => (h === "location" ? "https://mirror.example.com/b" : null) } };
    }
    return { status: 200, url, headers: { get: () => null } };
  }, () => httpsFetcher("https://repo.example.com/a"));
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["https://repo.example.com/a", "https://mirror.example.com/b"]);
});

test("httpsFetcher refuses a downgrade on the FIRST hop", async () => {
  await assert.rejects(
    () => withFetch(async () => { throw new Error("must not be called"); }, () => httpsFetcher("http://repo.example.com/x")),
    /redirected off https/,
  );
});

test("httpsFetcher refuses a downgrade on an INTERMEDIATE hop invisible to the final URL", async () => {
  // The scenario a naive redirect:"follow" + res.url check misses entirely:
  // https -> http -> https(attacker), where fetch resolves the whole chain
  // and only the last, innocent-looking URL is ever exposed.
  let calls = 0;
  await assert.rejects(
    () =>
      withFetch(async (url) => {
        calls++;
        if (url === "https://repo.example.com/a") {
          return { status: 302, headers: { get: (h) => (h === "location" ? "http://mitm.example.com/b" : null) } };
        }
        throw new Error("must not follow the http hop");
      }, () => httpsFetcher("https://repo.example.com/a")),
    /redirected off https/,
  );
  assert.equal(calls, 1); // the http hop is never fetched
});

test("httpsFetcher caps redirect chains rather than looping forever", async () => {
  await assert.rejects(
    () =>
      withFetch(
        async (url) => ({
          status: 302,
          headers: { get: (h) => (h === "location" ? "https://repo.example.com/next" : null) },
        }),
        () => httpsFetcher("https://repo.example.com/a"),
      ),
    /too many redirects/,
  );
});

// ---------------------------------------------------------------------------
// Pins the catalog cannot see.
// ---------------------------------------------------------------------------

// The real shape this exists for: the sibling Android consumers pin the
// Compose compiler plugin in `pluginManagement`, and foojay in the settings
// `plugins {}` block, where the catalog never sees either.
const SETTINGS_FIXTURE = `pluginManagement {
    repositories {
        maven { url = uri("https://example.com//artifacts") }
        gradlePluginPortal()
    }
    plugins {
        id("org.jetbrains.kotlin.plugin.compose") version "2.4.10"
        // id("org.example.retired") version "9.9.9"
    }
}
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}
`;

test("scanPluginPins reports every literal plugin pin in a settings script", () => {
  const pins = scanPluginPins(SETTINGS_FIXTURE);
  assert.deepEqual(pins, [
    { id: "org.jetbrains.kotlin.plugin.compose", version: "2.4.10", computedId: false },
    { id: "org.gradle.toolchains.foojay-resolver-convention", version: "1.0.0", computedId: false },
  ]);
});

test("scanPluginPins ignores a commented-out pin", () => {
  // Asserted against the fixture above, which carries one — so this fails if
  // the fixture ever loses it rather than passing on an empty scan.
  assert.match(SETTINGS_FIXTURE, /\/\/ *id\("org\.example\.retired"\)/);
  assert.equal(
    scanPluginPins(SETTINGS_FIXTURE).some((p) => p.id === "org.example.retired"),
    false,
  );
});

test("scanPluginPins leaves a catalog alias alone", () => {
  // `alias(libs.plugins.x)` and a bare `id(...)` carry no literal version, so
  // the catalog already owns them and there is nothing to report.
  const pins = scanPluginPins(`plugins {
    alias(libs.plugins.android.application) apply false
    id("org.jetbrains.kotlin.plugin.compose")
}`);
  assert.deepEqual(pins, []);
});

test("scanPluginPins reads both Groovy spellings", () => {
  assert.deepEqual(
    scanPluginPins("plugins {\n  id 'com.example.one' version '1.2'\n  id('com.example.two').version('2.0')\n}"),
    [
      { id: "com.example.one", version: "1.2", computedId: false },
      { id: "com.example.two", version: "2.0", computedId: false },
    ],
  );
});

test("scanPluginPins reports a pin once however often it is mentioned", () => {
  const pins = scanPluginPins(`pluginManagement {
    plugins { id("com.example.one") version "1.2" }
}
plugins { id("com.example.one") version "1.2" }`);
  assert.deepEqual(pins, [{ id: "com.example.one", version: "1.2", computedId: false }]);
});

test("stripScriptComments does not cut a URL at its double slash", () => {
  // The reason the strip is quote-aware: a naive one truncates every
  // repository URL, which is how a scan starts inventing pins.
  const stripped = stripScriptComments('maven { url = uri("https://example.com//a") } // trailing');
  assert.match(stripped, /https:\/\/example\.com\/\/a/);
  assert.doesNotMatch(stripped, /trailing/);
});

test("stripScriptComments removes a block comment without joining its neighbors", () => {
  assert.equal(stripScriptComments("a/* cut */b"), "a b");
});

test("scanPluginPins reads Gradle's kotlin() shorthand", () => {
  // `kotlin("jvm")` names org.jetbrains.kotlin.jvm through a different
  // keyword; missing it would leave exactly the pin this scan exists to find.
  assert.deepEqual(
    scanPluginPins(`plugins {
    kotlin("jvm") version "2.1.0"
    kotlin("plugin.serialization") version "2.1.0"
}`),
    [
      { id: "org.jetbrains.kotlin.jvm", version: "2.1.0", computedId: false },
      { id: "org.jetbrains.kotlin.plugin.serialization", version: "2.1.0", computedId: false },
    ],
  );
});

test("scanPluginPins ignores a declaration that is only string content", () => {
  // A generated-script template or a printed message is data, not a
  // declaration, and reporting it would put a plugin nobody declared in the
  // weekly PR.
  assert.deepEqual(
    scanPluginPins(`println('id("com.example.foo") version "1.2.3"')`),
    [],
  );
  assert.deepEqual(
    scanPluginPins('val template = "id(\\"com.example.foo\\") version \\"1.2.3\\""'),
    [],
  );
});

test("scanPluginPins still reports a real pin on a line that also has a string", () => {
  // The narrowing must not cost a real finding: the mask is consulted for the
  // keyword's position only, and a declaration's own arguments are strings.
  assert.deepEqual(
    scanPluginPins(`plugins { id("com.example.one") version "1.2" } // note: "quoted"`),
    [{ id: "com.example.one", version: "1.2", computedId: false }],
  );
});

test("scanScript marks string interiors and leaves code unmarked", () => {
  const { text, inString } = scanScript('id("a")');
  assert.equal(text, 'id("a")');
  // Assert the scan actually found the token before trusting the mask.
  assert.equal(text.indexOf("id"), 0);
  assert.equal(inString[0], false); // the `id` keyword is code
  assert.equal(inString[text.indexOf("a")], true); // the argument is not
});

test("a triple-quoted string does not swallow the code after it", () => {
  // The failure this guards is a MISSED pin, not a spurious one: treating
  // `"""` as three single quotes flipped the quote parity whenever the body
  // held an odd number of them, so every real declaration after it was marked
  // as string content and dropped.
  const script = `val t = """say " now"""
plugins { id("com.example.real") version "1.2" }`;
  // Assert the body really does carry the odd quote that used to break it.
  assert.match(script, /"""say " now"""/);
  assert.deepEqual(scanPluginPins(script), [
    { id: "com.example.real", version: "1.2", computedId: false },
  ]);
});

test("a declaration inside a triple-quoted template is not reported", () => {
  assert.deepEqual(scanPluginPins('val t = """id("fake") version "9.9""""'), []);
  assert.deepEqual(scanPluginPins("val t = \'\'\'id(\"fake\") version \"9.9\"\'\'\'"), []);
});

test("scanPluginPins reads raw-string arguments as whole literals", () => {
  // `id("""x""") version """1.0"""` is valid Kotlin. Taking the first quote of
  // each triple as the delimiter reported the pin as `""x""` at version `"`,
  // which is not noise but a wrong entry naming a pin the engine can see.
  assert.deepEqual(
    scanPluginPins(`plugins { id("""com.example.foo""") version """1.2.3""" }`),
    [{ id: "com.example.foo", version: "1.2.3", computedId: false }],
  );
  // Mixed delimiters in one declaration are legal too.
  assert.deepEqual(
    scanPluginPins(`plugins { id("""com.example.two""") version "9.9" }`),
    [{ id: "com.example.two", version: "9.9", computedId: false }],
  );
});

// One fixture, read under each language's comment rules. There is no outer
// `*/` on purpose: under Kotlin's the inner one only closes the inner comment,
// so the whole file is comment, while under Groovy's it closes the only
// comment there is and a live declaration follows. That is the entire
// difference between the two tests below, and it is why the caller states the
// language rather than the scanner guessing — nesting a Groovy comment would
// run past its real end and swallow a pin.
const NESTED_COMMENT_SRC = `plugins { /* outer /* inner */ id("com.example.fake") version "1.2" }`;

test("a raw-string argument cannot cross its own closing triple", () => {
  // The same runaway the whole-literal alternation was written to rule out,
  // surviving in the branches that could still cross themselves: a lazy run
  // backtracks past its own closing delimiter when the rest of the pattern
  // fails, so an unversioned raw-string declaration ahead of a real one
  // produced ONE corrupted id spanning both and swallowed the pin.
  assert.deepEqual(
    scanPluginPins(
      `plugins {\n  id("""java""")\n  id("""com.example.real""") version """1.2"""\n}`,
      { nestedBlockComments: true },
    ),
    [{ id: "com.example.real", version: "1.2", computedId: false }],
  );
  // Groovy's triple-quote spelling has the same shape and the same fix.
  assert.deepEqual(
    scanPluginPins(
      `plugins {\n  id('''java''')\n  id('''com.example.g''') version '''1.2'''\n}`,
    ),
    [{ id: "com.example.g", version: "1.2", computedId: false }],
  );
  // The guard: a raw string may still contain a lone quote, which is the case
  // a delimiter that stopped at every quote would have broken.
  assert.deepEqual(
    scanPluginPins(`val t = """say " now"""\nplugins { id("com.example.q") version "1.2" }`),
    [{ id: "com.example.q", version: "1.2", computedId: false }],
  );
});

test("a nested block comment is comment all the way to its outer close in Kotlin", () => {
  assert.deepEqual(scanPluginPins(NESTED_COMMENT_SRC, { nestedBlockComments: true }), []);
});

test("a nested block comment closes at the first terminator in Groovy", () => {
  assert.deepEqual(scanPluginPins(NESTED_COMMENT_SRC), [
    { id: "com.example.fake", version: "1.2", computedId: false },
  ]);
});

test("an ordinary block comment still yields the pin after it, either way", () => {
  // The guard against depth tracking costing a real finding.
  const src = `/* c */ plugins { id("com.example.real") version "1.2" }`;
  for (const options of [undefined, { nestedBlockComments: true }]) {
    assert.deepEqual(scanPluginPins(src, options), [
      { id: "com.example.real", version: "1.2", computedId: false },
    ]);
  }
});

test("scanPluginPins reports a pin whose version is a name, not a literal", () => {
  // `version pluginVersion` is a valid declaration Gradle resolves to whatever
  // the variable holds. Matching only the literal spelling produced NO entry
  // at all for it — not a withheld value, an omitted plugin — which is the
  // silent skip the whole scan exists to prevent.
  assert.deepEqual(
    scanPluginPins(`def pluginVersion = "1.2"
plugins { id("com.example.foo") version pluginVersion }`),
    [{ id: "com.example.foo", version: null, computedId: false }],
  );
  // The catalog-accessor spelling, and the parenthesized Kotlin one.
  assert.deepEqual(
    scanPluginPins(`plugins { id("com.example.bar") version libs.versions.bar.get() }`),
    [{ id: "com.example.bar", version: null, computedId: false }],
  );
  assert.deepEqual(
    scanPluginPins(`plugins { id("com.example.baz").version(pluginVersion) }`),
    [{ id: "com.example.baz", version: null, computedId: false }],
  );
  // Still nothing for a declaration that pins no version at all — the `version`
  // keyword is what separates the two, not the shape of what follows it.
  assert.deepEqual(scanPluginPins(`plugins { id("com.example.none") }`), []);
});

test("scanPluginPins reports a pin whose version operand is any expression", () => {
  // The `version` keyword is what marks a pin, not the shape of what follows
  // it. An operand that starts with punctuation matched none of the shapes the
  // pattern used to enumerate, so the declaration produced no entry at all —
  // the same silent skip as the variable-only case, one shape further out.
  assert.deepEqual(
    scanPluginPins(`plugins { id("com.example.foo").version(["1.2"][0]) }`),
    [{ id: "com.example.foo", version: null, computedId: false }],
  );
  assert.deepEqual(
    scanPluginPins(`plugins { id("com.example.bar") version project.ext["v"] }`),
    [{ id: "com.example.bar", version: null, computedId: false }],
  );
  // The guard the optional operand needs: `version` absent still reports
  // nothing, so widening what may follow the keyword has not turned every
  // declaration into a pin.
  assert.deepEqual(scanPluginPins(`plugins { id("com.example.none") }`), []);
  assert.deepEqual(
    scanPluginPins(`plugins { alias(libs.plugins.foo) apply false }`),
    [],
  );
});

test("only a `plugins { … }` block holds plugin declarations", () => {
  // The operands on both sides are permissive on purpose — that is what ended
  // the shape enumeration — and the cost was that an ordinary `id(...)` call in
  // one statement and an ordinary `version` in the next completed a match
  // BETWEEN them, reporting a plugin nobody declared. Excluding one spelling at
  // a time (`version =`, then `version.toString()`, …) is that same open-ended
  // enumeration seen from the other end; the block boundary ends the class.
  for (const after of ['version = "1.2"', "version.toString()", 'version("1.2")']) {
    assert.deepEqual(
      scanPluginPins(`val artifactId = id("com.example.library")\n${after}\n`, {
        nestedBlockComments: true,
      }),
      [],
    );
  }
  // Inside a block, all three still read as declarations.
  assert.deepEqual(
    scanPluginPins(`plugins { id("com.example.real") version "1.2" }`),
    [{ id: "com.example.real", version: "1.2", computedId: false }],
  );
  // Nested inside `pluginManagement`, which is where a settings script puts it.
  assert.deepEqual(
    scanPluginPins(`pluginManagement {\n  plugins {\n    id("com.example.s") version "1.0"\n  }\n}`),
    [{ id: "com.example.s", version: "1.0", computedId: false }],
  );
  // A brace inside a string does not close the block early.
  assert.deepEqual(
    scanPluginPins(`plugins {\n  // a }\n  id("com.example.brace") version "1.0"\n}`),
    [{ id: "com.example.brace", version: "1.0", computedId: false }],
  );
  // And the word inside a string does not open one.
  assert.deepEqual(
    scanPluginPins(`val s = "plugins {"\nid("com.example.nope") version "1.0"`),
    [],
  );
});

test("a computed id may be a call chain split over several lines", () => {
  // Ordinary Kotlin formatting. Excluding newlines from the argument dropped
  // the declaration entirely — a silent omission, not a withheld value.
  const pins = scanPluginPins(
    `plugins {\n  id(providers\n    .gradleProperty("pluginId")\n    .get()) version "1.2"\n}`,
    { nestedBlockComments: true },
  );
  assert.equal(pins.length, 1);
  assert.equal(pins[0].version, "1.2");
  assert.equal(pins[0].computedId, true);
  // Collapsed onto one line, so the reported line stays a line.
  assert.equal(pins[0].id, 'providers .gradleProperty("pluginId") .get()');
  // The guard: it still cannot run from one declaration into the next.
  assert.deepEqual(
    scanPluginPins(`plugins {\n  id("java")\n  id("com.example.real") version "1.2"\n}`),
    [{ id: "com.example.real", version: "1.2", computedId: false }],
  );
});

test("a `version =` assignment does not complete a plugin declaration", () => {
  // Gradle's project-version assignment is not the declaration keyword. Once
  // the version operand became optional, an `id(...)` call in one statement and
  // this assignment in the next completed a match ACROSS them and reported a
  // plugin nobody declared — a wrong entry, which is worse than a missing or a
  // spurious one.
  assert.deepEqual(
    scanPluginPins('val artifactId = id("com.example.library")\nversion = "1.2"\n', {
      nestedBlockComments: true,
    }),
    [],
  );
  // The guard: a real declaration on its own line still reports.
  assert.deepEqual(
    scanPluginPins(`plugins {\n  id("com.example.real") version "1.2"\n}`),
    [{ id: "com.example.real", version: "1.2", computedId: false }],
  );
});

test("a bare core-plugin accessor ends a version expression", () => {
  // `plugins { id("x") version "1.2"; java }` is ordinary Kotlin — `java` is a
  // core-plugin accessor, not an operator. Whitelisting the WORDS that may
  // follow a version could never cover them, because an accessor is any
  // identifier Gradle publishes, so a real literal version got reported as
  // non-literal the moment one appeared.
  for (const accessor of ["java", "application", "war", "signing", "base"]) {
    const pins = scanPluginPins(
      `plugins {\n  id("com.example.foo") version "1.2"\n  ${accessor}\n}`,
    );
    // Asserted, so a fixture that stops reaching the branch cannot pass quietly.
    assert.equal(pins.length, 1);
    assert.equal(pins[0].version, "1.2");
  }
});

test("a word operator does not end a version expression", () => {
  // The terminator whitelist admitted any identifier for a round, so the `i`
  // of a word operator read as the end of the expression and the fragment
  // before it was reported as a pinned version.
  assert.deepEqual(
    scanPluginPins(`plugins { id("com.example.a").version("1" in ["1"] ? "2" : "3") }`),
    [{ id: "com.example.a", version: null, computedId: false }],
  );
  // The rest of the closed set the check names — language keywords, which is
  // why naming these rather than the terminators is the direction that works.
  for (const [op, id] of [
    ["as String", "com.example.as"],
    ["is String", "com.example.is"],
    ["instanceof String", "com.example.io"],
  ]) {
    assert.deepEqual(scanPluginPins(`plugins { id("${id}").version("1.2" ${op}) }`), [
      { id, version: null, computedId: false },
    ]);
  }
  // The words that DO end one come from the plugins DSL, and each still does:
  // `apply` after a version, and the next declaration's own keyword.
  assert.deepEqual(
    scanPluginPins(`plugins { id("com.example.b") version "1.2" apply false }`),
    [{ id: "com.example.b", version: "1.2", computedId: false }],
  );
  for (const next of ['id("com.example.z") version "2.0"', 'kotlin("jvm") version "2.0"', "alias(libs.plugins.x)"]) {
    const pins = scanPluginPins(`plugins {\n  id("com.example.c") version "1.2"\n  ${next}\n}`);
    // Asserted so a fixture that stops reaching the branch cannot pass quietly.
    assert.equal(pins[0].id, "com.example.c");
    assert.equal(pins[0].version, "1.2");
  }
});

test("scanPluginPins reports a pin whose id is an expression", () => {
  // `id(pluginId)` is a declaration Gradle resolves — in a settings
  // `pluginManagement` block, which is not the restricted plugins DSL — and
  // requiring a literal here produced no entry at all for it. Same silent skip
  // as the version side, one argument over.
  assert.deepEqual(
    scanPluginPins(`plugins { id(pluginId) version "1.2" }`),
    [{ id: "pluginId", version: "1.2", computedId: true }],
  );
  // Two levels of nesting, which is what a property lookup and its `.get()`
  // need.
  assert.deepEqual(
    scanPluginPins(`plugins { id(providers.gradleProperty("suffix").get()) version "1.2" }`),
    [
      {
        id: 'providers.gradleProperty("suffix").get()',
        version: "1.2",
        computedId: true,
      },
    ],
  );
  // And it reads as computed, so the expression is never printed as though it
  // were the plugin's name.
  assert.match(
    unmanagedPinLine(scanPluginPins(`plugins { id(pluginId) version "1.2" }`)[0], "b"),
    /^plugin with a computed id `pluginId`/,
  );
  // The guards a widened id argument needs. Empty parentheses are not a
  // declaration, and neither is a declaration with no `version` keyword —
  // widening what may sit between the parentheses is exactly the change that
  // could have started reporting both.
  assert.deepEqual(scanPluginPins(`plugins { id() version "1.2" }`), []);
  assert.deepEqual(scanPluginPins(`plugins { id(pluginId) }`), []);
  assert.deepEqual(scanPluginPins(`plugins { alias(libs.plugins.foo) apply false }`), []);
  // Still cannot run from one declaration into the next: the argument never
  // crosses a `)`.
  assert.deepEqual(
    scanPluginPins(`plugins {\n  id("java")\n  id("com.example.real") version "1.2"\n}`),
    [{ id: "com.example.real", version: "1.2", computedId: false }],
  );
});

test("an interpolated plugin id is reported as computed, not as a name", () => {
  // Gradle resolves the template at configuration time, so the source text is
  // not the plugin's id. Printing it as one names a plugin that does not
  // exist — a wrong entry, which this repo ranks below a spurious one.
  const src =
    'plugins { id("com.example.${providers.gradleProperty(\'s\').get()}") version "1.2" }';
  const pins = scanPluginPins(src);
  // Asserted before the line, so this cannot pass on a scan that found nothing.
  assert.equal(pins.length, 1);
  assert.equal(pins[0].version, "1.2");
  assert.match(
    unmanagedPinLine(pins[0], "settings.gradle"),
    /^plugin with a computed id `com\.example\.\$\{/,
  );
  // A `$name` template counts too, and so does one in the Kotlin spelling.
  assert.match(
    unmanagedPinLine(scanPluginPins('plugins { id("com.example.$suffix") version "1.2" }')[0], "b"),
    /^plugin with a computed id /,
  );
});

test("unmanagedPinLine names an ordinary pin plainly", () => {
  // The guard against the two withholding branches swallowing the common case.
  assert.equal(
    unmanagedPinLine({ id: "com.example.foo", version: "1.2", computedId: false }, "settings.gradle.kts"),
    'plugin com.example.foo: pinned "1.2" in settings.gradle.kts, outside the catalog',
  );
  assert.equal(
    unmanagedPinLine({ id: "com.example.foo", version: null, computedId: false }, "settings.gradle.kts"),
    "plugin com.example.foo: pinned in settings.gradle.kts with a non-literal version, outside the catalog",
  );
});

test("scanPluginPins follows a version expression across a line break", () => {
  // An expression continues over a newline freely, so this is the version 1.2
  // Gradle resolves. Treating the line ending as a terminator reported the
  // fragment `1.` — a plain version by the predicate, and pinned nowhere.
  assert.deepEqual(
    scanPluginPins(`plugins {
    id("com.example.foo").version("1."
        + "2")
}`),
    [{ id: "com.example.foo", version: null, computedId: false }],
  );
  // The guard against that fix costing a real finding: a pin that ends its
  // line is still whole, whatever line the next terminator turns up on.
  assert.deepEqual(
    scanPluginPins(`plugins {
    id("com.example.real") version "1.2"
}`),
    [{ id: "com.example.real", version: "1.2", computedId: false }],
  );
});

test("scanPluginPins withholds a version it cannot read as a literal", () => {
  // A quoted token is not automatically a pinned version. Reporting
  // `$pluginVersion` or the fragment `1.` names a version that is pinned
  // nowhere — a wrong entry, worse than saying nothing about the value. The
  // pin itself is still reported: being outside the catalog is the fact the
  // section exists to surface.
  assert.deepEqual(
    scanPluginPins(`plugins { id("com.example.foo") version "$pluginVersion" }`),
    [{ id: "com.example.foo", version: null, computedId: false }],
  );
  assert.deepEqual(
    scanPluginPins(`plugins { id("com.example.bar").version("1." + minor) }`),
    [{ id: "com.example.bar", version: null, computedId: false }],
  );
  // The method spelling of the same concatenation. Checking only for `+`
  // caught the operator form and let this one report the fragment `1.`.
  assert.deepEqual(
    scanPluginPins(`plugins { id("com.example.baz").version("1.".plus(minor)) }`),
    [{ id: "com.example.baz", version: null, computedId: false }],
  );
  // Groovy string repetition: `"1" * 2` is version 11, and naming operators
  // one at a time had let `*` through to report the fragment `1`. The check
  // is a whitelist of terminators now, so an unnamed operator cannot pass.
  assert.deepEqual(
    scanPluginPins(`plugins { id("com.example.qux").version("1" * 2) }`),
    [{ id: "com.example.qux", version: null, computedId: false }],
  );
});

test("scanPluginPins still reads a literal followed by apply false", () => {
  // The guard against that rejection over-reaching: `apply false` is ordinary
  // Gradle, so a whitelist of terminators would have withheld a real version.
  assert.deepEqual(
    scanPluginPins(`plugins { id("com.example.one") version "1.2" apply false }`),
    [{ id: "com.example.one", version: "1.2", computedId: false }],
  );
  // And the parenthesized form, where `)` follows the literal, not `.`.
  assert.deepEqual(
    scanPluginPins(`plugins { id("com.example.two").version("1.2") }`),
    [{ id: "com.example.two", version: "1.2", computedId: false }],
  );
  // A line ending and end-of-file finish the expression as surely as a
  // bracket does — the two cases a terminator whitelist most easily forgets.
  assert.deepEqual(
    scanPluginPins(`plugins {\n  id("com.example.three") version "1.2"\n}`),
    [{ id: "com.example.three", version: "1.2", computedId: false }],
  );
  assert.deepEqual(scanPluginPins(`plugins { id("com.example.four") version "1.2"`), [
    { id: "com.example.four", version: "1.2", computedId: false },
  ]);
});

test("scanPluginPins still reports an ordinary literal version", () => {
  // The guard against that withholding costing a real value, including a
  // prerelease qualifier, which isPlainVersion accepts.
  assert.deepEqual(
    scanPluginPins(`plugins { id("com.example.one") version "1.2" }`),
    [{ id: "com.example.one", version: "1.2", computedId: false }],
  );
  assert.deepEqual(
    scanPluginPins(`plugins { id("com.example.two") version "1.0-alpha" }`),
    [{ id: "com.example.two", version: "1.0-alpha", computedId: false }],
  );
});

test("an unversioned declaration does not swallow the pin after it", () => {
  // A lazy run between two delimiters backtracks across its own closing quote
  // when the rest of the pattern fails, so `id("java")` ran into the next
  // declaration: one corrupted id, and the real pin gone from the report.
  // A missed pin is the failure this scan exists to prevent.
  assert.deepEqual(
    scanPluginPins(`plugins {
    id("java")
    id("com.example.real") version "1.2"
}`),
    [{ id: "com.example.real", version: "1.2", computedId: false }],
  );
});

