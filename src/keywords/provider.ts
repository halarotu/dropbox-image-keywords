/** Anything that can turn an image into keywords. Swap implementations via config. */
export interface KeywordProvider {
  readonly name: string;
  readonly model: string;
  extractKeywords(image: Buffer, mediaType: "image/jpeg" | "image/png"): Promise<string[]>;
}

/** Errors that will never succeed on retry (e.g. the model refused the image). */
export class PermanentProviderError extends Error {}
