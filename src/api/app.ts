import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { dropboxErrorSummary, isDropboxError, isRateLimited } from "../dropbox/client";
import type { ThumbnailSize } from "../dropbox/thumbnails";
import { InvalidCursorError, type ImagesRepo } from "../firestore/imagesRepo";
import type { ImageDoc } from "../firestore/types";
import { normalizeKeywords } from "../keywords/normalize";
import { log } from "../util/logger";
import { requireIap, sameOriginOnly, type AuthEnv, type IapVerifier } from "./auth";

export interface AppDeps {
  images: Pick<ImagesRepo, "search" | "getDone">;
  fetchThumbnail: (dropboxId: string, size: ThumbnailSize) => Promise<Buffer>;
  /** null disables authentication (local development only). */
  verifier: IapVerifier | null;
  /** Directory of the built SPA; omit to serve the API only. */
  webDistDir?: string;
}

export const THUMBNAIL_SIZES = { small: "w480h320", large: "w2048h1536" } as const satisfies Record<
  string,
  ThumbnailSize
>;

const MAX_TERMS = 30; // array-contains-any accepts at most 30 values

const searchQuery = z.object({
  q: z.string().trim().min(1).max(500),
  mode: z.enum(["all", "any"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
});

const thumbnailQuery = z.object({
  size: z.enum(["small", "large"]).default("small"),
  /** The image's contentHash. When it matches, the response can be cached forever. */
  v: z.string().optional(),
});

/** What the frontend gets: no retry bookkeeping or other internals. */
export function toImageDto(img: ImageDoc) {
  return {
    id: img.dropboxId.replace(/^id:/, ""),
    name: img.name,
    path: img.path,
    keywords: img.keywords,
    modifiedAt: img.modifiedAt.toDate().toISOString(),
    contentHash: img.contentHash,
  };
}

/** Same normalisation as the stored keywords, so "Dogs, Beach!" finds "dogs" and "beach". */
export function parseSearchTerms(q: string): string[] {
  return normalizeKeywords(q.split(/[\s,]+/), MAX_TERMS);
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get("/api/healthz", (c) => c.text("ok"));

  const api = new Hono<AuthEnv>();
  api.use(sameOriginOnly(), requireIap(deps.verifier));

  api.get("/search", async (c) => {
    const parsed = searchQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "Invalid query", issues: parsed.error.issues }, 400);
    const { q, mode, limit, cursor } = parsed.data;

    const terms = parseSearchTerms(q);
    if (!terms.length) return c.json({ error: "Query has no searchable terms" }, 400);

    const page = await deps.images.search(terms, { mode, limit, cursor });
    log.info("Search", { user: c.get("user"), terms, mode, results: page.items.length });
    c.header("Cache-Control", "no-store");
    return c.json({ terms, items: page.items.map(toImageDto), nextCursor: page.nextCursor });
  });

  api.get("/images/:id", async (c) => {
    const img = await deps.images.getDone(c.req.param("id"));
    if (!img) return c.json({ error: "Not found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json(toImageDto(img));
  });

  api.get("/images/:id/thumbnail", async (c) => {
    const parsed = thumbnailQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "Invalid query", issues: parsed.error.issues }, 400);
    const { size, v } = parsed.data;

    // Look the image up first, so only indexed images can be fetched, not any file in the Dropbox.
    const img = await deps.images.getDone(c.req.param("id"));
    if (!img) return c.json({ error: "Not found" }, 404);

    const etag = `"${img.contentHash}-${size}"`;
    const cacheControl =
      v && v === img.contentHash ? "private, max-age=31536000, immutable" : "private, max-age=300";
    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304, { ETag: etag, "Cache-Control": cacheControl });
    }

    try {
      const jpeg = await deps.fetchThumbnail(img.dropboxId, THUMBNAIL_SIZES[size]);
      return c.body(new Uint8Array(jpeg), 200, {
        "Content-Type": "image/jpeg",
        ETag: etag,
        "Cache-Control": cacheControl,
      });
    } catch (err) {
      if (isRateLimited(err)) {
        return c.json({ error: "Dropbox rate limit, try again shortly" }, 503, { "Retry-After": "5" });
      }
      if (isDropboxError(err) && dropboxErrorSummary(err).startsWith("path/not_found")) {
        return c.json({ error: "Not found" }, 404);
      }
      throw err;
    }
  });

  api.all("*", (c) => c.json({ error: "Not found" }, 404));
  app.route("/api", api);

  if (deps.webDistDir) {
    const root = deps.webDistDir;
    // Vite puts content-hashed files under /assets, so they never change.
    app.use(
      "/assets/*",
      serveStatic({
        root,
        onFound: (_path, c) => c.header("Cache-Control", "public, max-age=31536000, immutable"),
      }),
    );
    // index.html must be revalidated so a new deploy is picked up.
    const noCacheHtml = (path: string, c: Context) => {
      if (path.endsWith(".html")) c.header("Cache-Control", "no-cache");
    };
    app.use("*", serveStatic({ root, onFound: noCacheHtml }));
    // Any other path is a client-side route: serve the SPA shell.
    app.get("*", serveStatic({ path: `${root}/index.html`, onFound: noCacheHtml }));
  }

  app.onError((err, c) => {
    if (err instanceof InvalidCursorError) return c.json({ error: err.message }, 400);
    log.error("Request failed", { err, path: c.req.path });
    return c.json({ error: "Internal error" }, 500);
  });

  return app;
}
