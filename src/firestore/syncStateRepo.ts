import { Firestore, Timestamp } from "@google-cloud/firestore";
import { COLLECTIONS } from "./db";
import type { SyncStateDoc } from "./types";

export class SyncStateRepo {
  constructor(private readonly db: Firestore) {}

  private ref(root: string) {
    // Firestore ids can't contain "/", so encode the folder path.
    const id = root === "" ? "root" : encodeURIComponent(root.toLowerCase());
    return this.db.collection(COLLECTIONS.syncState).doc(id);
  }

  async getCursor(root: string): Promise<string | null> {
    const snap = await this.ref(root).get();
    return snap.exists ? ((snap.data() as SyncStateDoc).cursor ?? null) : null;
  }

  async saveCursor(root: string, cursor: string | null): Promise<void> {
    const doc: SyncStateDoc = { root, cursor, lastScanAt: Timestamp.now() };
    await this.ref(root).set(doc);
  }
}
