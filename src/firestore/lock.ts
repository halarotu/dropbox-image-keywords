import { Firestore, Timestamp } from "@google-cloud/firestore";
import { randomUUID } from "node:crypto";
import { COLLECTIONS } from "./db";

/**
 * Lease-based lock so that two runs never overlap (e.g. a slow run and the next
 * scheduled one). If a run crashes, the lease simply expires.
 */
export class RunLock {
  readonly owner = randomUUID();
  private readonly ref;

  constructor(
    private readonly db: Firestore,
    private readonly leaseMinutes: number,
    name = "runner",
  ) {
    this.ref = db.collection(COLLECTIONS.locks).doc(name);
  }

  async acquire(): Promise<boolean> {
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(this.ref);
      const now = Timestamp.now();
      const expiresAt = snap.get("expiresAt") as Timestamp | undefined;
      if (snap.exists && expiresAt && expiresAt.toMillis() > now.toMillis()) {
        return false;
      }
      tx.set(this.ref, {
        owner: this.owner,
        acquiredAt: now,
        expiresAt: Timestamp.fromMillis(now.toMillis() + this.leaseMinutes * 60_000),
      });
      return true;
    });
  }

  async release(): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(this.ref);
      if (snap.exists && snap.get("owner") === this.owner) tx.delete(this.ref);
    });
  }
}
