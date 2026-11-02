import type { Timestamp } from "@google-cloud/firestore";

export type ImageStatus =
  | "pending" //    waiting for keywords (also used for retries, see nextAttemptAt)
  | "processing" // claimed by the current run
  | "done" //       keywords stored
  | "failed" //     gave up: max attempts reached or a permanent error
  | "deleted"; //   removed from Dropbox (keywords kept)

export interface ImageDoc {
  dropboxId: string;
  path: string;
  pathLower: string;
  name: string;
  rev: string;
  contentHash: string;
  sizeBytes: number;
  modifiedAt: Timestamp;

  status: ImageStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Timestamp | null;

  /** Keywords as returned by the model, normalised (lowercase, deduped). */
  keywords: string[];
  /** keywords + their individual words; this is what search queries should use. */
  searchTerms: string[];
  /** contentHash of the image version the keywords describe. */
  keywordsContentHash: string | null;
  keywordProvider: string | null;
  keywordModel: string | null;
  keywordsUpdatedAt: Timestamp | null;

  createdAt: Timestamp;
  updatedAt: Timestamp;
  deletedAt: Timestamp | null;
}

export interface SyncStateDoc {
  root: string;
  cursor: string | null;
  lastScanAt: Timestamp | null;
}
