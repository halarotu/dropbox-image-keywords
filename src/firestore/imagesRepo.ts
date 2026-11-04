import {
  DocumentReference,
  FieldPath,
  Firestore,
  Timestamp,
  type UpdateData,
  type WriteBatch,
} from "@google-cloud/firestore";
import { chunk } from "../util/concurrency";
import { COLLECTIONS } from "./db";
import type { ImageDoc, ImageStatus } from "./types";
import { docIdForDropboxId, type FileEntry } from "../dropbox/images";

const BATCH_LIMIT = 450; // Firestore allows 500 writes per batch; keep headroom.
/** AND searches filter in code; stop after this many candidates so one request stays cheap. */
const SEARCH_SCAN_LIMIT = 1000;

export type SearchMode = "all" | "any";

export interface SearchPage {
  items: ImageDoc[];
  /** Pass back as `cursor` for the next page; null when there are no more results. */
  nextCursor: string | null;
}

export class ImagesRepo {
  constructor(private readonly db: Firestore) {}

  private col() {
    return this.db.collection(COLLECTIONS.images);
  }

  ref(dropboxId: string): DocumentReference {
    return this.col().doc(docIdForDropboxId(dropboxId));
  }

  /**
   * Inserts new images and updates metadata of known ones. Decides whether
   * an image needs (re)processing. Returns counts for logging.
   */
  async upsertFromDropbox(
    entries: FileEntry[],
    opts: { reprocessOnChange: boolean },
  ): Promise<{ created: number; updated: number; queued: number }> {
    let created = 0;
    let updated = 0;
    let queued = 0;

    for (const group of chunk(entries, BATCH_LIMIT)) {
      const refs = group.map((e) => this.ref(e.id));
      const snaps = await this.db.getAll(...refs);
      const batch = this.db.batch();
      const now = Timestamp.now();

      group.forEach((entry, i) => {
        const snap = snaps[i];
        const meta = {
          dropboxId: entry.id,
          path: entry.path_display ?? entry.name,
          pathLower: entry.path_lower ?? entry.name.toLowerCase(),
          name: entry.name,
          rev: entry.rev,
          contentHash: entry.content_hash ?? "",
          sizeBytes: entry.size,
          modifiedAt: Timestamp.fromDate(new Date(entry.server_modified)),
          updatedAt: now,
        };

        if (!snap.exists) {
          const doc: ImageDoc = {
            ...meta,
            status: "pending",
            attempts: 0,
            lastError: null,
            nextAttemptAt: now,
            keywords: [],
            searchTerms: [],
            keywordsContentHash: null,
            keywordProvider: null,
            keywordModel: null,
            keywordsUpdatedAt: null,
            createdAt: now,
            deletedAt: null,
          };
          batch.create(refs[i], doc);
          created++;
          queued++;
          return;
        }

        const existing = snap.data() as ImageDoc;
        const next = decideStatus(existing, meta.contentHash, opts.reprocessOnChange);
        const update: UpdateData<ImageDoc> = { ...meta, deletedAt: null };
        if (next) {
          update.status = next;
          if (next === "pending") {
            update.attempts = 0;
            update.lastError = null;
            update.nextAttemptAt = now;
            queued++;
          }
        }
        batch.update(refs[i], update);
        updated++;
      });

      await batch.commit();
    }
    return { created, updated, queued };
  }

  /**
   * Marks images at `pathLower`, or anywhere below it (a deleted folder), as deleted.
   * Keywords are kept so a restored file doesn't need to be processed again.
   */
  async markDeletedByPath(pathLower: string): Promise<number> {
    const exact = await this.col().where("pathLower", "==", pathLower).get();
    const below = await this.col()
      .where("pathLower", ">=", `${pathLower}/`)
      .where("pathLower", "<", `${pathLower}/\uf8ff`)
      .get();

    const docs = [...exact.docs, ...below.docs].filter((d) => d.get("status") !== "deleted");
    const now = Timestamp.now();
    for (const group of chunk(docs, BATCH_LIMIT)) {
      const batch = this.db.batch();
      for (const d of group) {
        batch.update(d.ref, { status: "deleted", deletedAt: now, updatedAt: now });
      }
      await batch.commit();
    }
    return docs.length;
  }

  /** Images left in "processing" by a crashed run go back to the queue. */
  async resetStuckProcessing(): Promise<number> {
    const snap = await this.col().where("status", "==", "processing").get();
    const now = Timestamp.now();
    for (const group of chunk(snap.docs, BATCH_LIMIT)) {
      const batch = this.db.batch();
      for (const d of group) batch.update(d.ref, { status: "pending", nextAttemptAt: now, updatedAt: now });
      await batch.commit();
    }
    return snap.size;
  }

  /** Pending images whose retry time has come. Needs the (status, nextAttemptAt) index. */
  async findDue(limit: number): Promise<Array<{ ref: DocumentReference; data: ImageDoc }>> {
    const snap = await this.col()
      .where("status", "==", "pending")
      .where("nextAttemptAt", "<=", Timestamp.now())
      .orderBy("nextAttemptAt", "asc")
      .limit(limit)
      .get();
    return snap.docs.map((d) => ({ ref: d.ref, data: d.data() as ImageDoc }));
  }

  /** An already-processed image with identical content (duplicate file), if any. */
  async findKeywordsForContent(contentHash: string, excludeRef: DocumentReference) {
    if (!contentHash) return null;
    const snap = await this.col().where("keywordsContentHash", "==", contentHash).limit(3).get();
    const hit = snap.docs.find((d) => d.ref.path !== excludeRef.path && (d.get("keywords") ?? []).length > 0);
    return hit ? (hit.data() as ImageDoc) : null;
  }

  async markProcessing(refs: DocumentReference[]): Promise<void> {
    const batch: WriteBatch = this.db.batch();
    const now = Timestamp.now();
    for (const ref of refs) batch.update(ref, { status: "processing", updatedAt: now });
    await batch.commit();
  }

  async saveKeywords(
    ref: DocumentReference,
    data: {
      keywords: string[];
      searchTerms: string[];
      contentHash: string;
      provider: string;
      model: string;
    },
  ): Promise<void> {
    const now = Timestamp.now();
    await ref.update({
      status: "done",
      keywords: data.keywords,
      searchTerms: data.searchTerms,
      keywordsContentHash: data.contentHash,
      keywordProvider: data.provider,
      keywordModel: data.model,
      keywordsUpdatedAt: now,
      lastError: null,
      nextAttemptAt: null,
      updatedAt: now,
    });
  }

  async markRetry(ref: DocumentReference, attempts: number, error: string, delayMs: number) {
    await ref.update({
      status: "pending",
      attempts,
      lastError: error.slice(0, 2000),
      nextAttemptAt: Timestamp.fromMillis(Date.now() + delayMs),
      updatedAt: Timestamp.now(),
    });
  }

  async markFailed(ref: DocumentReference, attempts: number, error: string) {
    await ref.update({
      status: "failed",
      attempts,
      lastError: error.slice(0, 2000),
      nextAttemptAt: null,
      updatedAt: Timestamp.now(),
    });
  }

  /** A tagged image by its document id, or null if it doesn't exist or has no keywords yet. */
  async getDone(id: string): Promise<ImageDoc | null> {
    const snap = await this.col().doc(id).get();
    if (!snap.exists || snap.get("status") !== "done") return null;
    return snap.data() as ImageDoc;
  }

  /**
   * Tagged images whose searchTerms contain all (or any) of `terms`, newest first.
   * Needs the (status, searchTerms, modifiedAt desc) index. Firestore allows one array-contains
   * per query, so "all" queries the most selective-looking term and filters the rest in code.
   */
  async search(
    terms: string[],
    opts: { mode: SearchMode; limit: number; cursor?: string | null },
  ): Promise<SearchPage> {
    if (!terms.length) return { items: [], nextCursor: null };

    let query = this.col().where("status", "==", "done");
    query =
      opts.mode === "any"
        ? query.where("searchTerms", "array-contains-any", terms)
        : query.where("searchTerms", "array-contains", pickQueryTerm(terms));
    query = query.orderBy("modifiedAt", "desc").orderBy(FieldPath.documentId(), "desc");

    const items: ImageDoc[] = [];
    let after = opts.cursor ? decodeCursor(opts.cursor) : null;
    let scanned = 0;
    const pageSize = opts.mode === "any" ? opts.limit + 1 : Math.max(opts.limit * 2, 50);

    while (scanned < SEARCH_SCAN_LIMIT) {
      const page = after ? query.startAfter(after.modifiedAt, after.id) : query;
      const snap = await page.limit(pageSize).get();
      for (const d of snap.docs) {
        const img = d.data() as ImageDoc;
        if (opts.mode === "all" && !matchesAll(img.searchTerms, terms)) continue;
        if (items.length === opts.limit) {
          // There's at least one more match: continue after the last one we return.
          return { items, nextCursor: encodeCursor(items[items.length - 1]) };
        }
        items.push(img);
      }
      scanned += snap.size;
      if (snap.size < pageSize) return { items, nextCursor: null }; // no more candidates
      const last = snap.docs[snap.docs.length - 1].data() as ImageDoc;
      after = { modifiedAt: last.modifiedAt, id: docIdForDropboxId(last.dropboxId) };
    }
    // Scan budget used up: let the client continue from where we stopped.
    return { items, nextCursor: after ? encodeCursorParts(after.modifiedAt, after.id) : null };
  }

  async markDeleted(ref: DocumentReference) {
    const now = Timestamp.now();
    await ref.update({ status: "deleted", deletedAt: now, updatedAt: now });
  }
}

/**
 * What status should a known image get after a metadata update from Dropbox?
 * Returns null to leave the status unchanged.
 */
export function decideStatus(
  existing: Pick<ImageDoc, "status" | "contentHash" | "keywordsContentHash" | "keywords">,
  newContentHash: string,
  reprocessOnChange: boolean,
): ImageStatus | null {
  const hasKeywords = existing.keywords.length > 0;
  const keywordsCurrent = hasKeywords && existing.keywordsContentHash === newContentHash;
  const contentChanged = existing.contentHash !== newContentHash;

  if (existing.status === "deleted") {
    // Restored or moved back into a watched folder.
    if (keywordsCurrent || (hasKeywords && !reprocessOnChange)) return "done";
    return "pending";
  }
  if (!contentChanged) return null;
  if (keywordsCurrent) return "done";
  if (!hasKeywords || reprocessOnChange) return "pending"; // also gives failed images a fresh start
  return null;
}

/** The longest term is usually the rarest, which keeps the candidate set small. */
export function pickQueryTerm(terms: readonly string[]): string {
  return terms.reduce((a, b) => (b.length > a.length ? b : a));
}

export function matchesAll(searchTerms: readonly string[], terms: readonly string[]): boolean {
  return terms.every((t) => searchTerms.includes(t));
}

/** Cursor = position in the (modifiedAt desc, id desc) order, as an opaque URL-safe string. */
export function encodeCursor(img: Pick<ImageDoc, "modifiedAt" | "dropboxId">): string {
  return encodeCursorParts(img.modifiedAt, docIdForDropboxId(img.dropboxId));
}

function encodeCursorParts(modifiedAt: Timestamp, id: string): string {
  return Buffer.from(JSON.stringify([modifiedAt.toMillis(), id])).toString("base64url");
}

export function decodeCursor(cursor: string): { modifiedAt: Timestamp; id: string } {
  try {
    const [millis, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof millis === "number" && typeof id === "string" && id) {
      return { modifiedAt: Timestamp.fromMillis(millis), id };
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorError();
}

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid cursor");
  }
}
