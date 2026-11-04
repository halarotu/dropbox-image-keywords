import { z } from "zod";

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) =>
      s
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    );

/** Settings shared by the job and the API. */
const shared = {
  // Dropbox (scoped app with files.metadata.read + files.content.read)
  DROPBOX_APP_KEY: z.string().min(1),
  DROPBOX_APP_SECRET: z.string().min(1),
  DROPBOX_REFRESH_TOKEN: z.string().min(1),

  // Firestore
  GCP_PROJECT_ID: z.string().optional(),
  FIRESTORE_DATABASE_ID: z.string().default("(default)"),
};

const schema = z.object({
  ...shared,
  /** Comma-separated Dropbox folders to watch. "" means the whole Dropbox / app folder. */
  DROPBOX_ROOTS: csv(""),
  IMAGE_EXTENSIONS: csv("jpg,jpeg,png,gif,webp,tif,tiff,bmp"),

  // Keyword provider
  KEYWORD_PROVIDER: z.enum(["ollama"]).default("ollama"),
  /** Base URL of the Ollama server, e.g. https://ollama-xxxx.europe-west1.run.app */
  LLM_URL: z.string().url().optional(),
  /** Must be a vision-capable model that is pulled on the server. */
  LLM_MODEL: z.string().default("gemma3:4b"),
  /** "google-id-token" when the LLM is a Cloud Run service that requires authentication. */
  LLM_AUTH: z.enum(["none", "google-id-token"]).default("none"),
  /** Generous, so a GPU cold start (loading the model) doesn't time out. */
  LLM_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(180),
  KEYWORD_LANGUAGE: z.string().default("English"),
  MAX_KEYWORDS: z.coerce.number().int().positive().default(20),

  // Worker behaviour
  BATCH_SIZE: z.coerce.number().int().positive().default(50),
  CONCURRENCY: z.coerce.number().int().positive().default(3),
  MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** Re-run keyword extraction when an image's content changes. */
  REPROCESS_ON_CHANGE: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),
  LOCK_LEASE_MINUTES: z.coerce.number().int().positive().default(30),
});

const apiSchema = z.object({
  ...shared,
  PORT: z.coerce.number().int().positive().default(8080),
  /** "iap" verifies the signed header IAP adds to every request. "none" is for local development only. */
  API_AUTH: z.enum(["iap", "none"]).default("iap"),
  /** Cloud Run with IAP: /projects/PROJECT_NUMBER/locations/REGION/services/SERVICE_NAME */
  IAP_AUDIENCE: z.string().optional(),
  /** The built SPA (web/dist). Served for every path outside /api. */
  WEB_DIST_DIR: z.string().default("web/dist"),
});

export type Config = z.infer<typeof schema>;
export type ApiConfig = z.infer<typeof apiSchema>;
export type FirestoreConfig = Pick<Config, "GCP_PROJECT_ID" | "FIRESTORE_DATABASE_ID">;
export type DropboxConfig = Pick<Config, "DROPBOX_APP_KEY" | "DROPBOX_APP_SECRET" | "DROPBOX_REFRESH_TOKEN">;

function parse<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = parse(schema, env);
  if (cfg.KEYWORD_PROVIDER === "ollama" && !cfg.LLM_URL) {
    throw new Error("LLM_URL is required when KEYWORD_PROVIDER=ollama");
  }
  // Dropbox wants "" for the root and "/folder" (no trailing slash) for folders.
  cfg.DROPBOX_ROOTS = (cfg.DROPBOX_ROOTS.length ? cfg.DROPBOX_ROOTS : [""]).map((r) =>
    r === "/" ? "" : r.replace(/\/+$/, ""),
  );
  cfg.IMAGE_EXTENSIONS = cfg.IMAGE_EXTENSIONS.map((e) => e.toLowerCase().replace(/^\./, ""));
  return cfg;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const cfg = parse(apiSchema, env);
  if (cfg.API_AUTH === "iap" && !cfg.IAP_AUDIENCE) {
    throw new Error("IAP_AUDIENCE is required when API_AUTH=iap");
  }
  return cfg;
}
