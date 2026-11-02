# Ollama server with the vision model baked into the image, so a cold start
# doesn't download it. Deployed to Cloud Run with a GPU by deploy/setup-gcp.sh.
# Pin a specific ollama/ollama tag for reproducible builds.
FROM ollama/ollama:latest

ENV OLLAMA_HOST=0.0.0.0:8080
ENV OLLAMA_MODELS=/models
ENV OLLAMA_KEEP_ALIVE=-1
ENV OLLAMA_NUM_PARALLEL=4

ARG MODEL=gemma3:4b
RUN ollama serve & sleep 5 && ollama pull "$MODEL"

ENTRYPOINT ["ollama", "serve"]
