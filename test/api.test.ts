import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "@google-cloud/firestore";
import { createApp, parseSearchTerms, type AppDeps } from "../src/api/app";
import { decodeCursor, encodeCursor, matchesAll, pickQueryTerm, InvalidCursorError } from "../src/firestore/imagesRepo";
import type { ImageDoc } from "../src/firestore/types";

const img = {
  dropboxId: "id:abc",
  name: "dog.jpg",
  path: "/Photos/dog.jpg",
  keywords: ["dog", "beach"],
  searchTerms: ["dog", "beach"],
  modifiedAt: Timestamp.fromMillis(Date.UTC(2026, 0, 2)),
  contentHash: "hash1",
  status: "done",
  lastError: "should not leak",
} as unknown as ImageDoc;

function deps(overrides: Partial<AppDeps> = {}): AppDeps & { searches: unknown[] } {
  const searches: unknown[] = [];
  return {
    searches,
    images: {
      search: async (terms, opts) => {
        searches.push({ terms, ...opts });
        return { items: [img], nextCursor: null };
      },
      getDone: async (id) => (id === "abc" ? img : null),
    },
    fetchThumbnail: async () => Buffer.from([0xff, 0xd8]),
    verifier: async (assertion) => {
      if (assertion !== "good") throw new Error("bad");
      return "friend@example.com";
    },
    ...overrides,
  };
}

const iap = { "x-goog-iap-jwt-assertion": "good" };

test("search requires a valid IAP assertion", async () => {
  const app = createApp(deps());
  assert.equal((await app.request("/api/search?q=dog")).status, 401);
  assert.equal((await app.request("/api/search?q=dog", { headers: { "x-goog-iap-jwt-assertion": "x" } })).status, 401);
  assert.equal((await app.request("/api/search?q=dog", { headers: iap })).status, 200);
});

test("healthz needs no auth", async () => {
  const res = await createApp(deps()).request("/api/healthz");
  assert.equal(res.status, 200);
});

test("cross-site requests are rejected", async () => {
  const res = await createApp(deps()).request("/api/search?q=dog", {
    headers: { ...iap, "sec-fetch-site": "cross-site" },
  });
  assert.equal(res.status, 403);
});

test("search normalises terms and returns DTOs without internals", async () => {
  const d = deps();
  const res = await createApp(d).request("/api/search?q=Dogs,%20BEACH!&mode=any&limit=10", { headers: iap });
  const body = await res.json();
  assert.deepEqual(d.searches, [{ terms: ["dogs", "beach"], mode: "any", limit: 10, cursor: undefined }]);
  assert.deepEqual(body.items, [
    {
      id: "abc",
      name: "dog.jpg",
      path: "/Photos/dog.jpg",
      keywords: ["dog", "beach"],
      modifiedAt: "2026-01-02T00:00:00.000Z",
      contentHash: "hash1",
    },
  ]);
});

test("search validates input", async () => {
  const app = createApp(deps());
  assert.equal((await app.request("/api/search", { headers: iap })).status, 400);
  assert.equal((await app.request("/api/search?q=!!!", { headers: iap })).status, 400);
  assert.equal((await app.request("/api/search?q=dog&limit=500", { headers: iap })).status, 400);
});

test("thumbnail is immutable when the version matches, and supports 304", async () => {
  const app = createApp(deps());
  const res = await app.request("/api/images/abc/thumbnail?v=hash1", { headers: iap });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.match(res.headers.get("cache-control")!, /immutable/);

  const again = await app.request("/api/images/abc/thumbnail?v=hash1", {
    headers: { ...iap, "if-none-match": res.headers.get("etag")! },
  });
  assert.equal(again.status, 304);
});

test("unknown images are 404 and never reach Dropbox", async () => {
  let called = false;
  const app = createApp(deps({ fetchThumbnail: async () => ((called = true), Buffer.alloc(0)) }));
  assert.equal((await app.request("/api/images/nope/thumbnail", { headers: iap })).status, 404);
  assert.equal((await app.request("/api/images/nope", { headers: iap })).status, 404);
  assert.equal(called, false);
});

test("unknown API paths are JSON 404s", async () => {
  const res = await createApp(deps()).request("/api/nope", { headers: iap });
  assert.equal(res.status, 404);
});

test("parseSearchTerms splits on spaces and commas", () => {
  assert.deepEqual(parseSearchTerms(" Golden  retriever, beach "), ["golden", "retriever", "beach"]);
});

test("cursor round-trips and rejects garbage", () => {
  const c = decodeCursor(encodeCursor(img));
  assert.equal(c.id, "abc");
  assert.equal(c.modifiedAt.toMillis(), img.modifiedAt.toMillis());
  assert.throws(() => decodeCursor("garbage"), InvalidCursorError);
});

test("AND search helpers", () => {
  assert.equal(pickQueryTerm(["dog", "retriever", "sea"]), "retriever");
  assert.equal(matchesAll(["dog", "beach", "sunset"], ["dog", "beach"]), true);
  assert.equal(matchesAll(["dog", "sunset"], ["dog", "beach"]), false);
});
