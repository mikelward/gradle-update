// Exercises the clean-context validator over old/new catalog pairs. Every
// rule is asserted in both directions: the shape it admits and the shape it
// refuses. The validator's failure mode is a false pass — a diff it
// misparses as "no change" goes green — so the passing cases also assert the
// change list is exactly what the diff contained.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCatalogUpdate, verifyUpstream } from "./check-gradle-update.mjs";

const CATALOG = [
  "# comment",
  "[versions]",
  'agp = "9.2.0"',
  'coreKtx = "1.18.0"',
  'composeBom = "2026.05.01"',
  "",
  "[libraries]",
  'androidx-core-ktx = { group = "androidx.core", name = "core-ktx", version.ref = "coreKtx" }',
  "",
  "[plugins]",
  'android-application = { id = "com.android.application", version.ref = "agp" }',
].join("\n");

const bump = (text, from, to) => text.replace(`"${from}"`, `"${to}"`);

test("a plain in-major bump passes and is listed", () => {
  const result = validateCatalogUpdate(CATALOG, bump(CATALOG, "1.18.0", "1.19.0"));
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.deepEqual(result.changes, [{ key: "coreKtx", from: "1.18.0", to: "1.19.0" }]);
});

test("several bumps pass together", () => {
  const updated = bump(bump(CATALOG, "1.18.0", "1.19.0"), "2026.05.01", "2026.06.01");
  const result = validateCatalogUpdate(CATALOG, updated);
  assert.equal(result.ok, true);
  assert.equal(result.changes.length, 2);
});

test("an unchanged catalog is refused — the publish job should never see one", () => {
  const result = validateCatalogUpdate(CATALOG, CATALOG);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /unchanged/);
});

test("a major crossing is refused", () => {
  const result = validateCatalogUpdate(CATALOG, bump(CATALOG, "9.2.0", "10.0.0"));
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /crosses a major/);
});

test("a dashed numeric that Maven ranks older is refused — not an upgrade", () => {
  const pinned = CATALOG.replace('coreKtx = "1.18.0"', 'lib = "1.0.2"');
  const result = validateCatalogUpdate(pinned, bump(pinned, "1.0.2", "1.0-1"));
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /not an upgrade/);
});

test("a dashed-zero spelling that Maven ranks newer passes as an upgrade", () => {
  const withJre = CATALOG.replace('coreKtx = "1.18.0"', 'lib = "1.1-jre"');
  const result = validateCatalogUpdate(withJre, bump(withJre, "1.1-jre", "1.1-0-jre"));
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("a zero-padded respelling of a suffixed version is refused — not an upgrade", () => {
  const withJre = CATALOG.replace('coreKtx = "1.18.0"', 'lib = "1.0-jre"');
  const result = validateCatalogUpdate(withJre, bump(withJre, "1.0-jre", "1.0.0-jre"));
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /not an upgrade/);
});

test("a major crossing past 2^53 is still refused — no precision loss", () => {
  const huge = CATALOG.replace('coreKtx = "1.18.0"', 'stamp = "9007199254740992.1"');
  const result = validateCatalogUpdate(huge, bump(huge, "9007199254740992.1", "9007199254740993.2"));
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /crosses a major/);
});

test("a calendar-version year rollover counts as a major", () => {
  const result = validateCatalogUpdate(CATALOG, bump(CATALOG, "2026.05.01", "2027.01.01"));
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /crosses a major/);
});

test("a variant-suffix switch is refused; the same-variant upgrade passes", () => {
  const withVariant = CATALOG.replace('coreKtx = "1.18.0"', 'guava = "33.4.7-android"');
  const switched = validateCatalogUpdate(withVariant, bump(withVariant, "33.4.7-android", "33.4.8-jre"));
  assert.equal(switched.ok, false);
  assert.match(switched.errors[0], /switches the variant/);
  const kept = validateCatalogUpdate(withVariant, bump(withVariant, "33.4.7-android", "33.4.8-android"));
  assert.equal(kept.ok, true, kept.errors.join("; "));
});

test("a numbered-variant switch is refused too — jdk8 to jdk11 is a platform change", () => {
  const withJdk = CATALOG.replace('coreKtx = "1.18.0"', 'lib = "1.0-jdk8"');
  const switched = validateCatalogUpdate(withJdk, bump(withJdk, "1.0-jdk8", "1.1-jdk11"));
  assert.equal(switched.ok, false);
  assert.match(switched.errors[0], /switches the variant/);
  const kept = validateCatalogUpdate(withJdk, bump(withJdk, "1.0-jdk8", "1.1-jdk8"));
  assert.equal(kept.ok, true, kept.errors.join("; "));
});

test("a downgrade is refused", () => {
  const result = validateCatalogUpdate(CATALOG, bump(CATALOG, "1.18.0", "1.17.0"));
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /not an upgrade/);
});

test("a pre-release is refused", () => {
  const result = validateCatalogUpdate(CATALOG, bump(CATALOG, "1.18.0", "1.19.0-alpha01"));
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /pre-release/);
});

test("a change outside [versions] is refused", () => {
  const updated = CATALOG.replace('name = "core-ktx"', 'name = "core"');
  const result = validateCatalogUpdate(CATALOG, updated);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /outside the \[versions\] table/);
});

test("a comment change is refused even inside [versions]", () => {
  const withComment = CATALOG.replace('agp = "9.2.0"', 'agp = "9.2.0" # pinned');
  const result = validateCatalogUpdate(CATALOG, withComment);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /comment changed/);
});

test("a commented entry's bump passes with the comment intact, fails if the comment moved", () => {
  const commented = CATALOG.replace('coreKtx = "1.18.0"', 'coreKtx = "1.18.0" # pinned note');
  const kept = validateCatalogUpdate(commented, bump(commented, "1.18.0", "1.19.0"));
  assert.equal(kept.ok, true, kept.errors.join("; "));
  assert.deepEqual(kept.changes, [{ key: "coreKtx", from: "1.18.0", to: "1.19.0" }]);
  const edited = validateCatalogUpdate(
    commented,
    commented.replace('coreKtx = "1.18.0" # pinned note', 'coreKtx = "1.19.0" # different note'),
  );
  assert.equal(edited.ok, false);
  assert.match(edited.errors[0], /comment changed/);
});

test("a renamed key is refused", () => {
  const updated = CATALOG.replace('coreKtx = "1.18.0"', 'coreKtx2 = "1.19.0"');
  const result = validateCatalogUpdate(CATALOG, updated);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /key changed/);
});

test("added or removed lines are refused before any line comparison", () => {
  const added = CATALOG + '\nnewKey = "1.0.0"';
  const removed = CATALOG.split("\n").slice(0, -1).join("\n");
  for (const mutated of [added, removed]) {
    const result = validateCatalogUpdate(CATALOG, mutated);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /added or removed lines/);
  }
});

test("one bad change fails the batch even among good ones", () => {
  const updated = bump(bump(CATALOG, "1.18.0", "1.19.0"), "9.2.0", "10.0.0");
  const result = validateCatalogUpdate(CATALOG, updated);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  // The good change is still reported as parsed, but ok is what gates.
  assert.deepEqual(result.changes, [{ key: "coreKtx", from: "1.18.0", to: "1.19.0" }]);
});

test("a catalog with no [versions] table is refused", () => {
  const bare = ["[libraries]", 'a = { module = "g:a", version = "1.0" }'].join("\n");
  const result = validateCatalogUpdate(bare, bare.replace("1.0", "1.1"));
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /no \[versions\] table/);
});

test("a dotted-key bump passes — the validator admits what the engine writes", () => {
  const dotted = CATALOG.replace('coreKtx = "1.18.0"', 'foo.bar = "1.18.0"');
  const result = validateCatalogUpdate(dotted, bump(dotted, "1.18.0", "1.19.0"));
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.deepEqual(result.changes, [{ key: "foo.bar", from: "1.18.0", to: "1.19.0" }]);
});

test("a change to a range or dynamic version is refused", () => {
  const withRange = CATALOG.replace('coreKtx = "1.18.0"', 'coreKtx = "1.+"');
  const result = validateCatalogUpdate(withRange, bump(withRange, "1.+", "2.+"));
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /not a plain version bump/);
});

test("a pre-release pin graduating to its stable release passes", () => {
  const withRc = CATALOG.replace('coreKtx = "1.18.0"', 'lib = "2.0.0-rc1"');
  const result = validateCatalogUpdate(withRc, bump(withRc, "2.0.0-rc1", "2.0.0"));
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("a CR pin graduating to a Final release passes — no variant switch", () => {
  const withCr = CATALOG.replace('coreKtx = "1.18.0"', 'lib = "6.6.0.CR1"');
  const result = validateCatalogUpdate(withCr, bump(withCr, "6.6.0.CR1", "6.6.1.Final"));
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("a literal-string bump passes in its own quotes; a quote-style switch is refused", () => {
  const literal = CATALOG.replace('coreKtx = "1.18.0"', "coreKtx = '1.18.0'");
  const kept = validateCatalogUpdate(literal, literal.replace("'1.18.0'", "'1.19.0'"));
  assert.equal(kept.ok, true, kept.errors.join("; "));
  const switched = validateCatalogUpdate(literal, literal.replace("'1.18.0'", '"1.19.0"'));
  assert.equal(switched.ok, false);
  assert.match(switched.errors[0], /quote style changed/);
});

test("a quoted-key bump passes — the validator admits what the engine writes", () => {
  const quoted = CATALOG.replace('coreKtx = "1.18.0"', '"core.ktx" = "1.18.0"');
  const result = validateCatalogUpdate(quoted, bump(quoted, "1.18.0", "1.19.0"));
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.deepEqual(result.changes, [{ key: "core.ktx", from: "1.18.0", to: "1.19.0" }]);
});

test("a bump under a commented [versions] header passes", () => {
  const commented = CATALOG.replace("[versions]", "[versions] # dependency pins");
  const result = validateCatalogUpdate(commented, bump(commented, "1.18.0", "1.19.0"));
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("a bump under a quoted [versions] header passes", () => {
  const quoted = CATALOG.replace("[versions]", '["versions"]');
  const result = validateCatalogUpdate(quoted, bump(quoted, "1.18.0", "1.19.0"));
  assert.equal(result.ok, true, result.errors.join("; "));
});

// ---------------------------------------------------------------------------
// Upstream re-verification: the publish job's answer to a forged artifact.
// The fingerprint travels from the machine that ran the batch's own Gradle
// code, so these tests pin the property the texts alone cannot give — every
// new version must really exist upstream, for every module sharing its key,
// published outside the cooldown.
// ---------------------------------------------------------------------------

const REPO = "https://repo.example.com/m2";
const NOW = new Date("2026-08-15T00:00:00Z");
const OLD = "2020-01-01T00:00:00Z"; // far outside any cooldown
const FRESH = "2026-08-14T00:00:00Z"; // the day before NOW

// Same stub shape as update-versions.test.js: url -> { versions, dates }
// keyed by "<group>:<artifact>".
const makeFetcher = (modules) => async (url, init = {}) => {
  const metadata = /^(.*)\/(.+?)\/maven-metadata\.xml$/.exec(url);
  if (metadata) {
    const key = `${metadata[1].slice(REPO.length + 1).replaceAll("/", ".")}:${metadata[2]}`;
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
    const key = `${pom[1].slice(REPO.length + 1).replaceAll("/", ".")}:${pom[2]}`;
    const date = modules[key]?.dates?.[pom[3]];
    if (!date) return { ok: false, status: 404, headers: { get: () => null } };
    return { ok: true, status: 200, headers: { get: () => date } };
  }
  return { ok: false, status: 404, headers: { get: () => null } };
};

const verify = (newText, changes, modules) =>
  verifyUpstream(newText, changes, {
    fetcher: makeFetcher(modules),
    cooldownDays: 5,
    now: NOW,
    repositories: [REPO],
  });

const BUMPED = bump(CATALOG, "1.18.0", "1.19.0");
const CORE = [{ key: "coreKtx", from: "1.18.0", to: "1.19.0" }];

test("verifyUpstream passes a version the repository lists outside the cooldown", async () => {
  const errors = await verify(BUMPED, CORE, {
    "androidx.core:core-ktx": { versions: ["1.18.0", "1.19.0"], dates: { "1.19.0": OLD } },
  });
  assert.deepEqual(errors, []);
});

test("verifyUpstream refuses a version no repository lists", async () => {
  const errors = await verify(BUMPED, CORE, {
    "androidx.core:core-ktx": { versions: ["1.18.0"], dates: {} },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no repository lists/);
});

test("verifyUpstream refuses a version inside the cooldown", async () => {
  const errors = await verify(BUMPED, CORE, {
    "androidx.core:core-ktx": { versions: ["1.18.0", "1.19.0"], dates: { "1.19.0": FRESH } },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /inside the 5-day cooldown/);
});

test("verifyUpstream refuses a version with no publish date — the fail-closed direction", async () => {
  const errors = await verify(BUMPED, CORE, {
    "androidx.core:core-ktx": { versions: ["1.18.0", "1.19.0"], dates: {} },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cooldown cannot be verified/);
});

test("verifyUpstream skips the date lookup when the cooldown is disabled", async () => {
  // Mirrors decideUpdate's own cooldownDays <= 0 shortcut: a caller that
  // disabled the cooldown does not need a date, so a repository that omits
  // Last-Modified must not block an otherwise-valid publish over a check
  // nobody asked for. Existence is still required.
  const errors = await verifyUpstream(BUMPED, CORE, {
    fetcher: makeFetcher({
      "androidx.core:core-ktx": { versions: ["1.18.0", "1.19.0"], dates: {} },
    }),
    cooldownDays: 0,
    now: NOW,
    repositories: [REPO],
  });
  assert.deepEqual(errors, []);
});

test("verifyUpstream still refuses a nonexistent version when the cooldown is disabled", async () => {
  const errors = await verifyUpstream(BUMPED, CORE, {
    fetcher: makeFetcher({
      "androidx.core:core-ktx": { versions: ["1.18.0"], dates: {} },
    }),
    cooldownDays: 0,
    now: NOW,
    repositories: [REPO],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no repository lists/);
});

test("verifyUpstream refuses when the repository errors rather than trusting a partial answer", async () => {
  const failing = async () => ({ ok: false, status: 503, text: async () => "" });
  const errors = await verifyUpstream(BUMPED, CORE, {
    fetcher: failing,
    cooldownDays: 5,
    now: NOW,
    repositories: [REPO],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /could not verify/);
});

test("verifyUpstream refuses a changed key nothing references", async () => {
  const errors = await verify(BUMPED, [{ key: "ghost", from: "1.0", to: "1.1" }], {});
  assert.equal(errors.length, 1);
  assert.match(errors[0], /nothing vouches/);
});

test("verifyUpstream holds a shared key until every module lists the version", async () => {
  const shared = [
    "[versions]",
    'lifecycle = "2.10.1"',
    "[libraries]",
    'runtime = { group = "androidx.lifecycle", name = "lifecycle-runtime-compose", version.ref = "lifecycle" }',
    'viewmodel = { group = "androidx.lifecycle", name = "lifecycle-viewmodel-compose", version.ref = "lifecycle" }',
  ].join("\n");
  const errors = await verify(shared, [{ key: "lifecycle", from: "2.10.0", to: "2.10.1" }], {
    "androidx.lifecycle:lifecycle-runtime-compose": {
      versions: ["2.10.0", "2.10.1"],
      dates: { "2.10.1": OLD },
    },
    "androidx.lifecycle:lifecycle-viewmodel-compose": { versions: ["2.10.0"], dates: {} },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /lifecycle-viewmodel-compose/);
});
