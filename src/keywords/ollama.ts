import { z } from "zod";
import { PermanentProviderError, type KeywordProvider } from "./provider";

const outputSchema = z.object({ keywords: z.array(z.string()).min(1) });

const chatResponseSchema = z.object({
  message: z.object({ content: z.string() }),
  done_reason: z.string().optional(),
});

const METADATA_IDENTITY_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

/**
 * Talks to a self-hosted Ollama server (e.g. on Cloud Run with a GPU) through its
 * native chat API. A JSON schema in `format` makes the model return structured
 * output instead of free text.
 */
export class OllamaKeywordProvider implements KeywordProvider {
  readonly name = "ollama";
  private readonly baseUrl: string;
  private idToken?: { value: string; expiresAt: number };

  constructor(
    baseUrl: string,
    readonly model: string,
    private readonly auth: "none" | "google-id-token",
    private readonly timeoutMs: number,
    private readonly language: string,
    private readonly maxKeywords: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async extractKeywords(image: Buffer, _mediaType: "image/jpeg" | "image/png"): Promise<string[]> {
    const body = {
      model: this.model,
      stream: false,
      options: { temperature: 0.2, num_predict: 500 },
      format: {
        type: "object",
        properties: { keywords: { type: "array", items: { type: "string" } } },
        required: ["keywords"],
      },
      messages: [
        {
          role: "system",
          content:
            "You tag photos for a searchable image library. Return concise, concrete keywords " +
            "a person would type to find this image: main subjects, objects, setting/place type, " +
            "activities, notable colours, season/time of day, and the photo type (e.g. selfie, " +
            "landscape, screenshot, document). Prefer single words or short noun phrases. " +
            "Do not guess names of private people. No sentences. " +
            `Respond with JSON: {"keywords": [...]} containing between 5 and ${this.maxKeywords} ` +
            `keywords in ${this.language}, most important first.`,
        },
        { role: "user", content: "Tag this image.", images: [image.toString("base64")] },
      ],
    };

    const res = await this.post("/api/chat", body);
    const parsedRes = chatResponseSchema.safeParse(res);
    if (!parsedRes.success) throw new Error(`Unexpected LLM response: ${parsedRes.error.message}`);

    let json: unknown;
    try {
      json = JSON.parse(parsedRes.data.message.content);
    } catch {
      throw new Error(
        `LLM returned invalid JSON (done_reason=${parsedRes.data.done_reason ?? "unknown"})`,
      );
    }
    const parsed = outputSchema.safeParse(json);
    if (!parsed.success) throw new Error(`Unexpected keyword output: ${parsed.error.message}`);
    return parsed.data.keywords;
  }

  /** POST with retries on network errors, 429 and 5xx (covers GPU cold starts). */
  private async post(path: string, body: unknown, maxRetries = 3): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(await this.authHeaders()) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt >= maxRetries) throw err;
        await sleep(backoffMs(attempt));
        continue;
      }

      if (res.ok) return res.json();

      const text = (await res.text().catch(() => "")).slice(0, 500);
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      // 400 from Ollama usually means the image or request can't be handled; retrying won't help.
      if (res.status === 400) throw new PermanentProviderError(`LLM rejected request: ${text}`);
      throw new Error(`LLM request failed (${res.status}): ${text}`);
    }
  }

  /**
   * A Cloud Run service that requires authentication expects a Google-signed ID token
   * whose audience is the service URL. On Cloud Run the metadata server issues one.
   */
  private async authHeaders(): Promise<Record<string, string>> {
    if (this.auth === "none") return {};
    if (!this.idToken || this.idToken.expiresAt <= Date.now()) {
      const url = `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(this.baseUrl)}`;
      const res = await fetch(url, { headers: { "Metadata-Flavor": "Google" } });
      if (!res.ok) throw new Error(`Failed to fetch ID token from metadata server (${res.status})`);
      // Tokens are valid for 1 h; refresh well before that.
      this.idToken = { value: await res.text(), expiresAt: Date.now() + 45 * 60_000 };
    }
    return { authorization: `Bearer ${this.idToken.value}` };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt: number) => 2_000 * Math.pow(3, attempt) * (0.8 + Math.random() * 0.4);
