import {
  DocumentReference,
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
