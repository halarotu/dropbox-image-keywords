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

const schema = z.object({
  // Dropbox (scoped app with files.metadata.read + files.content.read)
  DROPBOX_APP_KEY: z.string().min(1),
  DROPBOX_APP_SECRET: z.string().min(1),
  DROPBOX_REFRESH_TOKEN: z.string().min(1),
  /** Comma-separated Dropbox folders to watch. "" means the whole Dropbox / app folder. */
  DROPBOX_ROOTS: csv(""),
  IMAGE_EXTENSIONS: csv("jpg,jpeg,png,gif,webp,tif,tiff,bmp"),

  // Firestore
  GCP_PROJECT_ID: z.string().optional(),
  FIRESTORE_DATABASE_ID: z.string().default("(default)"),

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

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
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
