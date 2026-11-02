import type { Config } from "../config";
import { OllamaKeywordProvider } from "./ollama";
import type { KeywordProvider } from "./provider";

export function createKeywordProvider(cfg: Config): KeywordProvider {
  switch (cfg.KEYWORD_PROVIDER) {
    case "ollama":
      return new OllamaKeywordProvider(
        cfg.LLM_URL!,
        cfg.LLM_MODEL,
        cfg.LLM_AUTH,
        cfg.LLM_TIMEOUT_SECONDS * 1000,
        cfg.KEYWORD_LANGUAGE,
        cfg.MAX_KEYWORDS,
      );
  }
}
