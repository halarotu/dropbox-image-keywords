import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSearchTerms, normalizeKeywords } from "../src/keywords/normalize";
import { decideStatus } from "../src/firestore/imagesRepo";
import { hasImageExtension } from "../src/dropbox/images";
import { deriveTakenYear } from "../src/dropbox/takenYear";

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

const NOW = new Date(Date.UTC(2026, 10, 5));
const year = (path: string) => deriveTakenYear(path, path.split("/").pop()!, NOW);

test("deriveTakenYear reads dates from common file names", () => {
  assert.deepEqual(year("/Camera Uploads/2016-05-04 12.34.56.jpg"), { year: 2016, source: "filename" });
  assert.deepEqual(year("/x/IMG_20160504_123456.jpg"), { year: 2016, source: "filename" });
  assert.deepEqual(year("/x/PXL_20210101_101010123.jpg"), { year: 2021, source: "filename" });
  assert.deepEqual(year("/x/Screenshot 2019-12-31 at 23.59.59.png"), { year: 2019, source: "filename" });
  assert.deepEqual(year("/x/photo_2018.07.15.jpg"), { year: 2018, source: "filename" });
});

test("deriveTakenYear prefers the file name over the folder", () => {
  assert.deepEqual(year("/Photos/2010/IMG_20160504_1.jpg"), { year: 2016, source: "filename" });
});

test("deriveTakenYear ignores invalid or implausible dates in file names", () => {
  assert.deepEqual(year("/x/IMG_20161340.jpg"), { year: 2026, source: "default" }); // month 13
  assert.deepEqual(year("/x/20230230.jpg"), { year: 2026, source: "default" }); // Feb 30
  assert.deepEqual(year("/x/20300101.jpg"), { year: 2026, source: "default" }); // future
  assert.deepEqual(year("/x/19850101.jpg"), { year: 2026, source: "default" }); // before MIN_YEAR
  assert.deepEqual(year("/x/1234201605049.jpg"), { year: 2026, source: "default" }); // part of a longer number
});

test("deriveTakenYear uses the deepest year-named folder", () => {
  assert.deepEqual(year("/Photos/2016/beach.jpg"), { year: 2016, source: "folder" });
  assert.deepEqual(year("/Photos/2016-07 Lapland/beach.jpg"), { year: 2016, source: "folder" });
  assert.deepEqual(year("/Photos/2016 Summer/day 2/beach.jpg"), { year: 2016, source: "folder" });
  assert.deepEqual(year("/2012/trips/2016/beach.jpg"), { year: 2016, source: "folder" });
  assert.deepEqual(year("/2012/trips/3000/beach.jpg"), { year: 2012, source: "folder" });
});

test("deriveTakenYear falls back to the current year", () => {
  assert.deepEqual(year("/Photos/Summer 2016/beach.jpg"), { year: 2026, source: "default" });
  assert.deepEqual(year("/Photos/20161/beach.jpg"), { year: 2026, source: "default" });
  assert.deepEqual(year("/2016.jpg"), { year: 2026, source: "default" }); // the file itself is not a folder
  assert.deepEqual(year("beach.jpg"), { year: 2026, source: "default" });
});
