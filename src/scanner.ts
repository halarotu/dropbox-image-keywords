import type { Dropbox, files } from "dropbox";
import type { Config } from "./config";
import { dropboxErrorSummary } from "./dropbox/client";
import { hasImageExtension, isDeleted, isFile, type FileEntry, type ListEntry } from "./dropbox/images";
import type { ImagesRepo } from "./firestore/imagesRepo";
import type { SyncStateRepo } from "./firestore/syncStateRepo";
import { log } from "./util/logger";

export interface ScanStats {
  pages: number;
  created: number;
  updated: number;
  queued: number;
  deleted: number;
}

/**
 * Pulls changes from Dropbox for every configured root. The first run lists everything;
 * later runs only receive changes since the stored cursor.
 */
export async function scanAll(
  cfg: Config,
  dbx: Dropbox,
  images: ImagesRepo,
  syncState: SyncStateRepo,
): Promise<ScanStats> {
  const total: ScanStats = { pages: 0, created: 0, updated: 0, queued: 0, deleted: 0 };
  for (const root of cfg.DROPBOX_ROOTS) {
    const stats = await scanRoot(root, cfg, dbx, images, syncState);
    for (const k of Object.keys(total) as (keyof ScanStats)[]) total[k] += stats[k];
  }
  return total;
}

async function scanRoot(
  root: string,
  cfg: Config,
  dbx: Dropbox,
  images: ImagesRepo,
  syncState: SyncStateRepo,
): Promise<ScanStats> {
  const stats: ScanStats = { pages: 0, created: 0, updated: 0, queued: 0, deleted: 0 };
  let cursor = await syncState.getCursor(root);
  log.info("Scanning Dropbox folder", { root: root || "/", mode: cursor ? "incremental" : "full" });

  let page: files.ListFolderResult;
  try {
    page = await firstPage(dbx, root, cursor);
  } catch (err) {
    // Dropbox can invalidate a cursor ("reset"); the fix is a full re-listing.
    if (cursor && dropboxErrorSummary(err).startsWith("reset")) {
      log.warn("Dropbox cursor was reset, doing a full re-listing", { root });
      cursor = null;
      page = await firstPage(dbx, root, null);
    } else {
      throw err;
    }
  }

  while (true) {
    stats.pages++;
    await applyPage(page.entries, cfg, images, stats);
    // Save progress after each page, so a crash never loses more than one page of work.
    await syncState.saveCursor(root, page.cursor);
    if (!page.has_more) break;
    page = (await dbx.filesListFolderContinue({ cursor: page.cursor })).result;
  }

  log.info("Scan finished", { root: root || "/", ...stats });
  return stats;
}

async function firstPage(dbx: Dropbox, root: string, cursor: string | null) {
  if (cursor) return (await dbx.filesListFolderContinue({ cursor })).result;
  return (
    await dbx.filesListFolder({
      path: root,
      recursive: true,
      include_deleted: false,
      include_media_info: false,
      limit: 2000,
    })
  ).result;
}

/**
 * Entries in a page must be applied in order. To keep Firestore writes batched, we first
 * fold the page in memory (a file that is created and deleted within the same page is
 * dropped), then apply deletions, then upserts. Moves show up as "deleted old path" +
 * "file at new path with the same id", which this ordering handles correctly.
 */
async function applyPage(entries: ListEntry[], cfg: Config, images: ImagesRepo, stats: ScanStats) {
  const upserts = new Map<string, FileEntry>(); // dropbox id -> latest entry
  const deletedPaths: string[] = [];

  for (const entry of entries) {
    if (isFile(entry)) {
      if (hasImageExtension(entry.name, cfg.IMAGE_EXTENSIONS)) upserts.set(entry.id, entry);
    } else if (isDeleted(entry) && entry.path_lower) {
      const p = entry.path_lower;
      for (const [id, e] of upserts) {
        const lp = e.path_lower ?? "";
        if (lp === p || lp.startsWith(`${p}/`)) upserts.delete(id);
      }
      deletedPaths.push(p);
    }
  }

  for (const p of deletedPaths) stats.deleted += await images.markDeletedByPath(p);

  if (upserts.size) {
    const r = await images.upsertFromDropbox([...upserts.values()], {
      reprocessOnChange: cfg.REPROCESS_ON_CHANGE,
    });
    stats.created += r.created;
    stats.updated += r.updated;
    stats.queued += r.queued;
  }
}
