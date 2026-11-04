import { Firestore } from "@google-cloud/firestore";
import type { FirestoreConfig } from "../config";

export const COLLECTIONS = {
  images: "images",
  syncState: "syncState",
  locks: "locks",
} as const;

/**
 * On Cloud Run the project and credentials come from the service account automatically.
 * Locally, run `gcloud auth application-default login` or set GOOGLE_APPLICATION_CREDENTIALS.
 */
export function createFirestore(cfg: FirestoreConfig): Firestore {
  return new Firestore({
    projectId: cfg.GCP_PROJECT_ID,
    databaseId: cfg.FIRESTORE_DATABASE_ID,
    ignoreUndefinedProperties: true,
  });
}
