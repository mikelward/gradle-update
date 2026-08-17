// Exercises the clean-context validator over old/new catalog pairs. Every
// rule is asserted in both directions: the shape it admits and the shape it
// refuses. The validator's failure mode is a false pass — a diff it
// misparses as "no change" goes green — so the passing cases also assert the
// change list is exactly what the diff contained.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCatalogUpdate } from "./check-versions-update.mjs";

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
