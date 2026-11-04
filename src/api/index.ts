import { serve } from "@hono/node-server";
import { loadApiConfig } from "../config";
import { createDropboxClient } from "../dropbox/client";
import { fetchThumbnail } from "../dropbox/thumbnails";
import { createFirestore } from "../firestore/db";
import { ImagesRepo } from "../firestore/imagesRepo";
import { log } from "../util/logger";
import { createApp } from "./app";
import { createIapVerifier } from "./auth";

const cfg = loadApiConfig();
const dbx = createDropboxClient(cfg);

if (cfg.API_AUTH === "none") log.warn("API_AUTH=none: authentication is disabled. Use only for local development.");

const app = createApp({
  images: new ImagesRepo(createFirestore(cfg)),
  fetchThumbnail: (dropboxId, size) => fetchThumbnail(dbx, dropboxId, size),
  verifier: cfg.API_AUTH === "iap" ? createIapVerifier(cfg.IAP_AUDIENCE!) : null,
  webDistDir: cfg.WEB_DIST_DIR,
});

const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
  log.info("API listening", { port: info.port, auth: cfg.API_AUTH });
});

// Cloud Run sends SIGTERM before stopping an instance; let in-flight requests finish.
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
