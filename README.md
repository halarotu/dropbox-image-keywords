# dropbox-image-keywords

A scheduled job (TypeScript + Node) that finds new images in your Dropbox, gets keywords for them from a self-hosted vision LLM (Ollama on Cloud Run with a GPU) and stores the keywords in Firestore, ready for a search feature.

```
Cloud Scheduler ──► Cloud Run Job ──► 1. scan:    Dropbox cursor → Firestore "images" (status=pending)
  (every 15 min)                       2. process: thumbnail → LLM service → keywords → Firestore (status=done)
                                                                 │
                                       Cloud Run service "ollama" (GPU, private, scales to zero)
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
  config.ts             env var validation (zod)
  scanner.ts            Dropbox change feed → Firestore
  worker.ts             pending images → keywords
  dropbox/              client (auto token refresh), error helpers, entry helpers
  firestore/            client, document types, images + sync-state repos, run lock
  keywords/             provider interface, Ollama implementation, normalisation
  util/                 logger (Cloud Logging JSON), concurrency, backoff
scripts/get-dropbox-refresh-token.ts   one-time OAuth helper
llm/Dockerfile                          Ollama server image with the vision model baked in
deploy/setup-gcp.sh                     APIs, Firestore, indexes, secrets, IAM, LLM service, job, schedule
test/logic.test.ts                      unit tests for the pure logic
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
gcloud run services proxy ollama --region europe-west1 --port 11434   # LLM_URL=http://localhost:11434, LLM_AUTH=none
```

```bash
cp .env.example .env              # fill in values
gcloud auth application-default login
npm run dev                       # scan + process once
npm test                          # unit tests
```

The worker query needs the composite index from `deploy/setup-gcp.sh` step 3. On the first run, Firestore's error message also includes a direct link that creates it.

### 3. Deploy to GCP

Edit the variables at the top of `deploy/setup-gcp.sh`, then run it from the project root. It enables the APIs, creates Firestore and the indexes, stores the secrets in Secret Manager, creates two least-privilege service accounts, deploys the LLM as a private Cloud Run service with an NVIDIA L4 GPU, deploys the Cloud Run Job and schedules it every 15 minutes.

The LLM service needs Cloud Run GPU quota in `LLM_REGION` (GPUs aren't available in every region, e.g. not in `europe-north1`). It only accepts authenticated requests: the job's service account has `roles/run.invoker` on it and sends a Google-signed ID token (`LLM_AUTH=google-id-token`). The model is pulled into the image at build time, so changing it means editing `ARG MODEL` in `llm/Dockerfile` and `LLM_MODEL` in the script, and redeploying. Run it once by hand with:

```bash
gcloud run jobs execute image-keywords --region europe-north1 --wait
```

Logs appear in Cloud Logging as structured JSON. Filter by `severity>=WARNING` to see problems.

## Firestore data model

`images/{dropboxFileId}`

| Field | Meaning |
|---|---|
| `path`, `pathLower`, `name` | current location in Dropbox |
| `contentHash`, `rev`, `sizeBytes`, `modifiedAt` | Dropbox metadata |
| `status` | `pending` · `processing` · `done` · `failed` · `deleted` |
| `keywords` | normalised keywords from the model, most important first |
| `searchTerms` | keywords **plus their individual words** — query this field |
| `keywordsContentHash` | which image version the keywords describe |
| `keywordProvider`, `keywordModel`, `keywordsUpdatedAt` | provenance, for re-tagging later |
| `attempts`, `lastError`, `nextAttemptAt` | retry bookkeeping |

`syncState/{root}` holds the Dropbox cursor per watched folder. `locks/runner` holds the run lock.

## Adding search later

`searchTerms` is designed for Firestore array queries. Normalise the user's input the same way the keywords were normalised:

```ts
import { normalizeKeywords } from "./keywords/normalize";

const terms = normalizeKeywords(userInput.split(/\s+/), 30); // array-contains-any allows max 30 values
const snap = await db.collection("images")
  .where("status", "==", "done")
  .where("searchTerms", "array-contains-any", terms)   // OR semantics
  .limit(100)
  .get();

// AND semantics ("dog beach" must match both): filter the OR results in code
const results = snap.docs.map((d) => d.data()).filter((img) => terms.every((t) => img.searchTerms.includes(t)));
```

This uses the second composite index created by the setup script. Firestore allows only one array-contains clause per query, which is why AND is done in code. That works well up to tens of thousands of images. If you later want ranking, typo tolerance or "similar meaning" search, you can add Firestore vector search on an embedding of the keywords, or sync to a search engine such as Typesense or Algolia.

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

**First sync of a large library:** the scan step lists everything quickly. Tagging the backlog then proceeds `BATCH_SIZE` images per run. To clear it faster, raise `BATCH_SIZE` for a while, but keep it so a run finishes well within the 25-minute task timeout and the 30-minute lock lease.

## Costs

Firestore usage per image is a few reads and writes when it is discovered and processed, plus one read per scheduled run for the queue query. Normal use fits within the free daily quota. A first sync of a very large library may exceed it for a day, which costs cents. Cloud Run Jobs, Scheduler and Secret Manager usage at this scale sit within or near their free allowances. The main cost is the GPU service. It is billed per second while an instance is running (including about 15 minutes of idle time before it scales back to zero), so with a 15-minute schedule it will rarely scale to zero. If new images are rare, schedule the job less often (e.g. hourly) to save money.

## Using a different keyword provider

Implement `KeywordProvider` in `src/keywords/provider.ts` (one method: image bytes in, string array out). Register it in `src/keywords/index.ts`, and add its name to the `KEYWORD_PROVIDER` enum in `config.ts`. Nothing else needs to change.

## Notes

Dropbox can only create thumbnails for files up to 20 MB in common image formats (`jpg`, `png`, `gif`, `webp`, `tif`, `bmp`). Other files are marked `failed` with the reason in `lastError`. HEIC/RAW support would need a download-and-convert step, for example with `sharp`.

Images are only sent to your own LLM service inside your GCP project; no third-party model API is involved.
