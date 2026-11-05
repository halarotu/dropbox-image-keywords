import { loadConfig } from "./config";
import { createDropboxClient } from "./dropbox/client";
import { createFirestore } from "./firestore/db";
import { ImagesRepo } from "./firestore/imagesRepo";
import { RunLock } from "./firestore/lock";
import { SyncStateRepo } from "./firestore/syncStateRepo";
import { createKeywordProvider } from "./keywords";
import { scanAll } from "./scanner";
import { log } from "./util/logger";
import { processDue } from "./worker";

const COMMANDS = ["scan", "process", "run", "backfill-taken-year"] as const;
type Command = (typeof COMMANDS)[number];

async function main(command: Command): Promise<number> {
  const cfg = loadConfig();
  const db = createFirestore(cfg);
  const dbx = createDropboxClient(cfg);
  const images = new ImagesRepo(db);
  const syncState = new SyncStateRepo(db);

  const lock = new RunLock(db, cfg.LOCK_LEASE_MINUTES);
  if (!(await lock.acquire())) {
    log.warn("Another run holds the lock; exiting");
    return 0;
  }

  const started = Date.now();
  try {
    if (command === "backfill-taken-year") {
      const r = await images.backfillTakenYear();
      log.info("Backfilled takenYear", { ...r, durationSec: Math.round((Date.now() - started) / 1000) });
      return 0;
    }
    if (command === "scan" || command === "run") {
      await scanAll(cfg, dbx, images, syncState);
    }
    if (command === "process" || command === "run") {
      const provider = createKeywordProvider(cfg);
      await processDue(cfg, dbx, images, provider);
    }
    log.info("Run complete", { command, durationSec: Math.round((Date.now() - started) / 1000) });
    return 0;
  } finally {
    await lock.release().catch((err) => log.error("Failed to release lock", { err }));
  }
}

const arg = (process.argv[2] ?? "run") as Command;
if (!COMMANDS.includes(arg)) {
  console.error(`Usage: node dist/index.js [${COMMANDS.join("|")}]`);
  process.exit(2);
}

main(arg)
  .then((code) => process.exit(code))
  .catch((err) => {
    log.error("Run failed", { err });
    process.exit(1);
  });
