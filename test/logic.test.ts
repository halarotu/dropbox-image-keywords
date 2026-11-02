import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSearchTerms, normalizeKeywords } from "../src/keywords/normalize";
import { decideStatus } from "../src/firestore/imagesRepo";
import { hasImageExtension } from "../src/dropbox/images";

test("normalizeKeywords cleans, dedupes and caps", () => {
  const out = normalizeKeywords(["  Golden Retriever ", "golden retriever", "Beach!", "", "Sunset."], 3);
  assert.deepEqual(out, ["golden retriever", "beach", "sunset"]);
});

test("buildSearchTerms adds individual words", () => {
  assert.deepEqual(buildSearchTerms(["golden retriever", "beach"]).sort(), [
    "beach",
    "golden",
    "golden retriever",
    "retriever",
  ]);
});

test("hasImageExtension is case-insensitive", () => {
  assert.equal(hasImageExtension("IMG_001.JPG", ["jpg"]), true);
  assert.equal(hasImageExtension("notes.txt", ["jpg"]), false);
});

const base = { status: "done" as const, contentHash: "a", keywordsContentHash: "a", keywords: ["x"] };

test("unchanged image keeps its status", () => {
  assert.equal(decideStatus(base, "a", true), null);
});

test("edited image is re-queued only when configured", () => {
  assert.equal(decideStatus(base, "b", true), "pending");
  assert.equal(decideStatus(base, "b", false), null);
});

test("restored image with current keywords goes straight to done", () => {
  assert.equal(decideStatus({ ...base, status: "deleted" }, "a", true), "done");
});

test("restored image without keywords is queued", () => {
  assert.equal(
    decideStatus({ status: "deleted", contentHash: "a", keywordsContentHash: null, keywords: [] }, "a", true),
    "pending",
  );
});

test("failed image gets a fresh start when its content changes", () => {
  assert.equal(
    decideStatus({ status: "failed", contentHash: "a", keywordsContentHash: null, keywords: [] }, "b", false),
    "pending",
  );
});
