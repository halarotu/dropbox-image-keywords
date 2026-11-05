# dropbox-image-keywords

A scheduled job (TypeScript + Node) that finds new images in your Dropbox, gets keywords for them from a self-hosted vision LLM (Ollama on Cloud Run with a GPU) and stores the keywords in Firestore. A small search UI and API, behind Identity-Aware Proxy, lets a handful of people search the images by keyword.

```
Cloud Scheduler ──► Cloud Run Job ──► 1. scan:    Dropbox cursor → Firestore "images" (status=pending)
  (every 15 min)                       2. process: thumbnail → LLM service → keywords → Firestore (status=done)
                                                                 │
                                       Cloud Run service "ollama" (GPU, private, scales to zero)

Browser ──► IAP (Google sign-in) ──► Cloud Run service "image-keywords-web"
                                       /        React SPA (web/)
                                       /api/*   search + thumbnails ──► Firestore, Dropbox (read-only)
```

## How it works

**Scan.** The first run lists every file under `DROPBOX_ROOTS` recursively. It stores a Dropbox *cursor* per folder, so later runs only receive what changed since then. New images are inserted as `pending`. Moved or renamed images keep their keywords, because documents are keyed by the stable Dropbox file id. Edited images are re-queued when `REPROCESS_ON_CHANGE=true`. Deleted files and folders are marked `deleted`, and their keywords are kept in case the file comes back. The cursor is saved after every page, so a crash loses at most one page of progress. If Dropbox resets a cursor, the job does a full re-listing.

**Process.** Each run takes up to `BATCH_SIZE` due images. For each one, it fetches a 1024×768 JPEG thumbnail from Dropbox. Small thumbnails are much cheaper to tag than originals, and quality is the same for keywords. The thumbnail goes to the LLM service, which returns keywords as structured JSON. The keywords are normalised (lowercase, trimmed, deduplicated) and saved. If another image with the identical `content_hash` was already tagged, its keywords are copied and no LLM call is made.

**Failures** are retried with exponential backoff (about 1 min, 4 min, 16 min, …) up to `MAX_ATTEMPTS`. After that the image is marked `failed` and `lastError` holds the reason. Permanent errors (unsupported format, a file too large to thumbnail, a request the LLM rejects) fail immediately. Transient LLM errors (5xx, 429, timeouts during a GPU cold start) are also retried inside the request.

**A lease lock** in Firestore (`locks/runner`) makes sure two runs never overlap. If a run crashes, the lease expires on its own and any images stuck in `processing` are re-queued by the next run.

## Project layout

```
src/
  index.ts              CLI entry: run | scan | process
  api/                  search API + static SPA hosting (Hono), IAP header check
  config.ts             env var validation (zod)
  scanner.ts            Dropbox change feed → Firestore
  worker.ts             pending images → keywords
  dropbox/              client (auto token refresh), error helpers, entry helpers, thumbnails
  firestore/            client, document types, images + sync-state repos, run lock
  keywords/             provider interface, Ollama implementation, normalisation
  util/                 logger (Cloud Logging JSON), concurrency, backoff
web/                                    search UI (React + Vite)
scripts/get-dropbox-refresh-token.ts   one-time OAuth helper
llm/Dockerfile                          Ollama server image with the vision model baked in
deploy/setup-gcp.sh                     APIs, Firestore, indexes, secrets, IAM, LLM service, job, schedule
test/                                   unit tests for the pure logic and the API
```

## Setup

### 1. Dropbox app

Create an app at https://www.dropbox.com/developers/apps with **Scoped access**. Choose **App folder** access if the images can live in one dedicated folder; otherwise choose **Full Dropbox**. On the *Permissions* tab, enable `files.metadata.read` and `files.content.read`, then submit. Then get a refresh token:

```bash
npm install
DROPBOX_APP_KEY=xxx DROPBOX_APP_SECRET=yyy npm run dropbox:token
```

### 2. Run locally

You need an Ollama server for keywords. Either run Ollama on your machine (`ollama pull gemma3:4b`), or, once deployed, tunnel to the Cloud Run service:

```bash
gcloud run services proxy ollama-qwen --region europe-west1 --port 11434   # LLM_URL=http://localhost:11434, LLM_AUTH=none
```

```bash
cp .env.example .env              # fill in values
gcloud auth application-default login
npm run dev                       # scan + process once
npm test                          # unit tests
```

To work on the search UI, run the API without IAP and the Vite dev server, which proxies `/api` to it:

```bash
npm run dev:api                   # API on :8080, API_AUTH=none
cd web && npm install && npm run dev
```

The worker query needs the composite index from `deploy/setup-gcp.sh` step 3. On the first run, Firestore's error message also includes a direct link that creates it.

### 3. Deploy to GCP

Edit the variables at the top of `deploy/setup-gcp.sh`, then run it from the project root. It enables the APIs, creates Firestore and the indexes, stores the secrets in Secret Manager, creates least-privilege service accounts, lets the job call the existing LLM service (`LLM_SERVICE` / `LLM_URL`), deploys the Cloud Run Job and schedules it every 15 minutes. It then deploys the search UI and API (see [Search UI and API](#search-ui-and-api)).

The LLM service is deployed separately, from `llm/Dockerfile`, as a private Cloud Run service with an NVIDIA L4 GPU. It needs Cloud Run GPU quota in `LLM_REGION` (GPUs aren't available in every region, e.g. not in `europe-north1`). It only accepts authenticated requests: the job's service account has `roles/run.invoker` on it and sends a Google-signed ID token (`LLM_AUTH=google-id-token`). The model is pulled into the image at build time, so changing it means editing `ARG MODEL` in `llm/Dockerfile` and `LLM_MODEL` in the script, and redeploying. Run it once by hand with:

```bash
gcloud run jobs execute image-keywords --region europe-north1 --wait
```

Logs appear in Cloud Logging as structured JSON. Filter by `severity>=WARNING` to see problems.

**Upgrading to the year filter.** Search sorts on `takenYear`, and Firestore leaves out documents that don't have that field. On an existing deployment, roll out in this order:

1. Deploy the job (step 7 of the script). New and updated images get `takenYear` from then on.
2. Fill in the existing images. This reads and writes only Firestore, no Dropbox or LLM calls, and is safe to re-run:
   ```bash
   gcloud run jobs execute image-keywords --region europe-north1 --wait --args=backfill-taken-year
   ```
3. Create the new index (step 3c of the script) and wait until `gcloud firestore indexes composite list` shows it as `READY`.
4. Deploy the API and web UI.
5. Delete the old `status, searchTerms, modifiedAt DESC` index.

## Firestore data model

`images/{dropboxFileId}`

| Field | Meaning |
|---|---|
| `path`, `pathLower`, `name` | current location in Dropbox |
| `contentHash`, `rev`, `sizeBytes`, `modifiedAt` | Dropbox metadata |
| `takenYear`, `takenYearSource` | Year the photo was taken, from a date in the file name (`filename`), else the deepest folder named after a year such as `2016` or `2016-07 Lapland` (`folder`), else the year the record was written (`default`). Recomputed whenever the scan updates the file. |
| `status` | `pending` · `processing` · `done` · `failed` · `deleted` |
| `keywords` | normalised keywords from the model, most important first |
| `searchTerms` | keywords **plus their individual words** — query this field |
| `keywordsContentHash` | which image version the keywords describe |
| `keywordProvider`, `keywordModel`, `keywordsUpdatedAt` | provenance, for re-tagging later |
| `attempts`, `lastError`, `nextAttemptAt` | retry bookkeeping |

`syncState/{root}` holds the Dropbox cursor per watched folder. `locks/runner` holds the run lock.

## Search UI and API

The Cloud Run service `image-keywords-web` runs the same image as the job with `node dist/api/index.js`. It serves the React SPA from `web/dist` and a read-only API under `/api`. Because the SPA and the API share an origin, there is no CORS. The API also rejects requests whose `Sec-Fetch-Site` header says they come from another site.

| Endpoint | Returns |
|---|---|
| `GET /api/search?q=dog beach&mode=all\|any&from=2016&to=2020&limit=50&cursor=…` | `{ terms, items: [{ id, name, path, keywords, modifiedAt, takenYear, contentHash }], nextCursor }`, by `takenYear` then `modifiedAt`, newest first. `from` and `to` are optional, inclusive years taken. |
| `GET /api/images/:id` | one tagged image |
| `GET /api/images/:id/thumbnail?size=small\|large&v=<contentHash>` | JPEG (480×320 or 2048×1536) fetched from Dropbox |
| `GET /api/healthz` | `ok`, no auth |

**Search.** Input is normalised the same way as the stored keywords and matched against `searchTerms`. `mode=any` uses `array-contains-any`. Firestore allows only one array-contains clause per query, so `mode=all` queries the longest term and filters the rest in code. It scans at most 1,000 candidates per request and returns a cursor to continue from.

**Images.** Thumbnails are streamed through the API rather than linked, so Dropbox links never reach the browser and images stay behind IAP. Only images that are in the index can be fetched. With `v` set to the image's `contentHash`, the browser caches a thumbnail for a year, because a changed image gets a new URL.

**Authentication.** Cloud Run's built-in IAP signs users in with Google before any request reaches the container. The API also verifies the `x-goog-iap-jwt-assertion` header IAP adds (`IAP_AUDIENCE` = `/projects/PROJECT_NUMBER/locations/REGION/services/image-keywords-web`). A request that somehow bypasses IAP is therefore still rejected.

### Managing users

Users sign in with their own Google account, for example a personal @gmail.com address. Personal accounts need IAP's *custom* OAuth client with an External audience; the setup script walks you through creating it once in the console. After that, add or remove a user with:

```bash
gcloud iap web add-iam-policy-binding --resource-type=cloud-run \
  --service=image-keywords-web --region=europe-north1 \
  --member=user:someone@example.com --role=roles/iap.httpsResourceAccessor

gcloud iap web remove-iam-policy-binding --resource-type=cloud-run \
  --service=image-keywords-web --region=europe-north1 \
  --member=user:someone@example.com --role=roles/iap.httpsResourceAccessor
```

List the current users with `gcloud iap web get-iam-policy --resource-type=cloud-run --service=image-keywords-web --region=europe-north1`.

## Configuration

See `.env.example`. These settings are the ones most worth tuning:

| Variable | Default | Notes |
|---|---|---|
| `DROPBOX_ROOTS` | whole Dropbox | comma-separated folders |
| `BATCH_SIZE` | 50 | images per run; at 15-minute intervals that's up to 4,800/day |
| `CONCURRENCY` | 3 | parallel LLM calls; keep ≤ the service's `--concurrency` / `OLLAMA_NUM_PARALLEL` (4) |
| `LLM_URL` | — | base URL of the Ollama server (set by the setup script on Cloud Run) |
| `LLM_MODEL` | `gemma3:4b` | must be a vision model that exists on the server; `qwen2.5vl:7b` is a heavier alternative |
| `LLM_AUTH` | `none` | `google-id-token` when calling the private Cloud Run service |
| `LLM_TIMEOUT_SECONDS` | 180 | per request; covers a GPU cold start |
| `KEYWORD_LANGUAGE` | English | language of the keywords |
| `REPROCESS_ON_CHANGE` | true | re-tag images whose content changed |

The search service uses the Dropbox and Firestore settings plus:

| Variable | Default | Notes |
|---|---|---|
| `API_AUTH` | `iap` | `none` disables the IAP check; local development only |
| `IAP_AUDIENCE` | — | required with `API_AUTH=iap` (set by the setup script) |
| `WEB_DIST_DIR` | `web/dist` | built SPA to serve |
| `PORT` | 8080 | set by Cloud Run |

**First sync of a large library:** the scan step lists everything quickly. Tagging the backlog then proceeds `BATCH_SIZE` images per run. To clear it faster, raise `BATCH_SIZE` for a while, but keep it so a run finishes well within the 25-minute task timeout and the 30-minute lock lease.

## Costs

Firestore usage per image is a few reads and writes when it is discovered and processed, plus one read per scheduled run for the queue query. Normal use fits within the free daily quota. A first sync of a very large library may exceed it for a day, which costs cents. Cloud Run Jobs, Scheduler and Secret Manager usage at this scale sit within or near their free allowances. The main cost is the GPU service. It is billed per second while an instance is running (including about 15 minutes of idle time before it scales back to zero), so with a 15-minute schedule it will rarely scale to zero. If new images are rare, schedule the job less often (e.g. hourly) to save money. The search service scales to zero and, for a few users, stays within the free tier.

## Using a different keyword provider

Implement `KeywordProvider` in `src/keywords/provider.ts` (one method: image bytes in, string array out). Register it in `src/keywords/index.ts`, and add its name to the `KEYWORD_PROVIDER` enum in `config.ts`. Nothing else needs to change.

## Notes

Dropbox can only create thumbnails for files up to 20 MB in common image formats (`jpg`, `png`, `gif`, `webp`, `tif`, `bmp`). Other files are marked `failed` with the reason in `lastError`. HEIC/RAW support would need a download-and-convert step, for example with `sharp`.

Images are only sent to your own LLM service inside your GCP project; no third-party model API is involved.
