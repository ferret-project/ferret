# AI features

Every AI feature is optional and runs on **your own models** — nothing about your things is sent to an outside AI
service. Each switches on when its setting is present; without them Ferret is a plain (and fast) inventory.

AI work happens in the background, one job at a time per kind, retried if a model is busy. **Nothing a model says is
applied by itself**: it becomes suggestions a person taps to accept — unless a household switches on
[Let AI fill in](../guide/ai#let-ai-fill-in) (empty fields only, off by default; you can make kinds the default for
this server's households under Settings → Server).

| Feature | Needs | What it does |
|---|---|---|
| Reading photos | `OLLAMA_URL` (a vision model, e.g. `qwen3-vl:8b`) | Describes each photo, reads text on it, suggests name, brand, model, serial number. Lists the things in a [room scan](../guide/room-scan) and where they are. |
| Reading documents | `DOCLING_URL` ([docling-serve](https://github.com/docling-project/docling-serve)); optionally `DOCLING_VLM_URL` | Turns PDFs and photos of paper into text, for search and suggestions. With `DOCLING_VLM_URL` (granite-docling behind an OpenAI-compatible API, e.g. vLLM), pages are read by that model instead of docling's standard pipeline. Ferret also reads the text a PDF carries itself and adds what docling missed (a parts list, a small table), under "Page N". When docling finds little or no text in a PDF (a scanned receipt or warranty card), the vision model reads its first page too. Without docling, a PDF's own text is used, and the vision model reads the first page of a scan. |
| Stronger answers | `CHAT_URL` (any OpenAI-compatible API, e.g. vLLM) | Ask Ferret, and reading receipts, warranties and manuals. Without it, the vision model does this too. |
| Smart search | `QDRANT_URL` + `OLLAMA_URL` (`EMBED_MODEL`) | Finds things by meaning, including inside documents. |
| Reranking | `RERANK_URL` | Better ordering of search results. |
| [AI helpers](../guide/ai) | `CHAT_URL` or `OLLAMA_URL` | Sorting imports, filters from plain words, replacement-cost estimates, typical upkeep. Possible duplicates by meaning also need smart search. |
| Speech to text | `SPEECH_URL` (an OpenAI-compatible `/v1/audio/transcriptions`, e.g. [speaches](https://github.com/speaches-ai/speaches) or vLLM with Whisper) | Saying a thing's name on a walkthrough. |

Changing `EMBED_MODEL` needs a new `QDRANT_COLLECTION` (the vectors are a different size). Use a separate collection
for each Ferret (e.g. one for testing).

## Other model servers (llama.cpp, LM Studio, vLLM)

Despite its name, `OLLAMA_URL` doesn't need Ollama: Ferret only calls the OpenAI-compatible `/v1/chat/completions`
(photos go as an `image_url`, and the reply is held to a JSON schema with `response_format`) and `/v1/embeddings`. Any
server that answers those works: llama.cpp's `llama-server`, LM Studio, vLLM.

```ini
OLLAMA_URL=http://gpu.lan:8080      # just the address: Ferret adds /v1/…
VISION_MODEL=qwen3-vl-8b            # the model name the server answers to
EMBED_MODEL=qwen3-embedding-8b
```

- The vision model needs its image part loaded (llama.cpp: `--mmproj`), or photos are refused.
- One `OLLAMA_URL` serves both `VISION_MODEL` and `EMBED_MODEL`. A plain `llama-server` runs one model, so put a
  proxy that picks the model by name in front of it (e.g. [llama-swap](https://github.com/mostlygeek/llama-swap)), or
  use llama-server's router mode. Embeddings are only asked for with `QDRANT_URL` set.
- `CHAT_URL` can be a different server from `OLLAMA_URL`.
- Smart search's cut-offs were tuned on `qwen3-embedding`. Another embedding model works, but matches by meaning may be
  a little stricter or looser.

If photos aren't read, Settings → Server lists the service errors with what the model server answered.
