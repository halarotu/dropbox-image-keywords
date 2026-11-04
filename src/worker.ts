import type { DocumentReference } from "@google-cloud/firestore";
import type { Dropbox } from "dropbox";
import type { Config } from "./config";
import { dropboxErrorSummary, isDropboxError } from "./dropbox/client";
import { fetchThumbnail } from "./dropbox/thumbnails";
import type { ImagesRepo } from "./firestore/imagesRepo";
import type { ImageDoc } from "./firestore/types";
import { buildSearchTerms, normalizeKeywords } from "./keywords/normalize";
import { PermanentProviderError, type KeywordProvider } from "./keywords/provider";
import { mapWithConcurrency } from "./util/concurrency";
import { log } from "./util/logger";
import { nextAttemptDelayMs } from "./util/retry";

export interface ProcessStats {
  done: number;
  reused: number;
  retrying: number;
  failed: number;
  gone: number;
}

type Outcome = keyof ProcessStats;

export async function processDue(
  cfg: Config,
  dbx: Dropbox,
  images: ImagesRepo,
  provider: KeywordProvider,
): Promise<ProcessStats> {
  const stats: ProcessStats = { done: 0, reused: 0, retrying: 0, failed: 0, gone: 0 };

  const reset = await images.resetStuckProcessing();
  if (reset) log.warn("Re-queued images left in 'processing' by an earlier run", { count: reset });

  const due = await images.findDue(cfg.BATCH_SIZE);
  if (!due.length) {
    log.info("No images to process");
    return stats;
  }
  await images.markProcessing(due.map((d) => d.ref));
  log.info("Processing images", { count: due.length });

  const outcomes = await mapWithConcurrency(due, cfg.CONCURRENCY, (item) =>
    processOne(item.ref, item.data, cfg, dbx, images, provider),
  );
  for (const o of outcomes) stats[o]++;
  log.info("Processing finished", { ...stats });
  return stats;
}

async function processOne(
  ref: DocumentReference,
  img: ImageDoc,
  cfg: Config,
  dbx: Dropbox,
  images: ImagesRepo,
  provider: KeywordProvider,
): Promise<Outcome> {
  const ctx = { id: img.dropboxId, path: img.path };
  try {
    // Duplicate of an image we already tagged? Reuse its keywords, skip the API call.
    const twin = await images.findKeywordsForContent(img.contentHash, ref);
    if (twin) {
      await images.saveKeywords(ref, {
        keywords: twin.keywords,
        searchTerms: twin.searchTerms,
        contentHash: img.contentHash,
        provider: twin.keywordProvider ?? provider.name,
        model: twin.keywordModel ?? provider.model,
      });
      log.info("Reused keywords from identical image", ctx);
      return "reused";
    }

    // A 1024x768 JPEG is plenty for tagging and keeps API costs down.
    const thumbnail = await fetchThumbnail(dbx, img.dropboxId, "w1024h768");
    const raw = await provider.extractKeywords(thumbnail, "image/jpeg");
    const keywords = normalizeKeywords(raw, cfg.MAX_KEYWORDS);
    if (!keywords.length) throw new Error("Model returned no usable keywords");

    await images.saveKeywords(ref, {
      keywords,
      searchTerms: buildSearchTerms(keywords),
      contentHash: img.contentHash,
      provider: provider.name,
      model: provider.model,
    });
    log.info("Stored keywords", { ...ctx, keywords });
    return "done";
  } catch (err) {
    return handleError(err, ref, img, cfg, images, ctx);
  }
}

async function handleError(
  err: unknown,
  ref: DocumentReference,
  img: ImageDoc,
  cfg: Config,
  images: ImagesRepo,
  ctx: Record<string, unknown>,
): Promise<Outcome> {
  const summary = dropboxErrorSummary(err);
  const message = summary || (err instanceof Error ? err.message : String(err));

  // File disappeared between scan and processing; the next scan confirms the deletion.
  if (isDropboxError(err) && summary.startsWith("path/not_found")) {
    await images.markDeleted(ref);
    log.info("Image no longer exists in Dropbox", ctx);
    return "gone";
  }

  // Errors that retrying won't fix: unsupported format, file too large to thumbnail, model refusal.
  const permanent =
    err instanceof PermanentProviderError ||
    summary.startsWith("unsupported_extension") ||
    summary.startsWith("unsupported_image") ||
    summary.startsWith("conversion_error") ||
    summary.startsWith("encrypted_content");

  const attempts = img.attempts + 1;
  if (permanent || attempts >= cfg.MAX_ATTEMPTS) {
    await images.markFailed(ref, attempts, message);
    log.error("Giving up on image", { ...ctx, attempts, error: message });
    return "failed";
  }

  const delay = nextAttemptDelayMs(attempts);
  await images.markRetry(ref, attempts, message, delay);
  log.warn("Image failed, will retry", { ...ctx, attempts, retryInSec: Math.round(delay / 1000), error: message });
  return "retrying";
}
