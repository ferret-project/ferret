# AI features

Every AI feature is optional and runs on **your own models** — nothing about your things is sent to an outside AI
service. Each switches on when its setting is present; without them Ferret is a plain (and fast) inventory.

AI work happens in the background, one job at a time per kind, retried if a model is busy. **Nothing a model says is
applied by itself**: it becomes suggestions a person taps to accept — unless a household switches on
[Let AI fill in](../guide/ai#let-ai-fill-in) (empty fields only, off by default; you can make kinds the default for
this server's households under Settings → Server).

| Feature | Needs | What it does |
|---|---|---|
| Reading photos | `VISION_URL` (a vision model, e.g. `qwen3-vl:8b`) | Describes each photo, reads text on it, suggests name, brand, model, serial number. Lists the things in a [room scan](../guide/room-scan) and where they are. |
| Reading documents | `DOCLING_URL` ([docling-serve](https://github.com/docling-project/docling-serve)); optionally `DOCLING_VLM_URL` | Turns PDFs and photos of paper into text, for search and suggestions. With `DOCLING_VLM_URL` (granite-docling behind an OpenAI-compatible API, e.g. vLLM), pages are read by that model instead of docling's standard pipeline. Ferret also reads the text a PDF carries itself and adds what docling missed (a parts list, a small table), under "Page N". When docling finds little or no text in a PDF (a scanned receipt or warranty card), the vision model reads its first page too. Without docling, a PDF's own text is used, and the vision model reads the first page of a scan. |
| Stronger answers | `CHAT_URL` (any OpenAI-compatible API, e.g. vLLM) | Ask Ferret, and reading receipts, warranties and manuals. Without it, the vision model does this too. |
| Smart search | `QDRANT_URL` + an embedding model (`EMBED_MODEL`, at `EMBED_URL` or else `VISION_URL`) | Finds things by meaning, including inside documents. |
| Reranking | `RERANK_URL` | Better ordering of search results. |
| [AI helpers](../guide/ai) | `CHAT_URL` or `VISION_URL` | Sorting imports, filters from plain words, replacement-cost estimates, typical upkeep. Possible duplicates by meaning also need smart search. |
| Speech to text | `SPEECH_URL` (an OpenAI-compatible `/v1/audio/transcriptions`, e.g. [speaches](https://github.com/speaches-ai/speaches) or vLLM with Whisper) | Saying a thing's name on a walkthrough. |

Changing `EMBED_MODEL` needs a new `QDRANT_COLLECTION` (the vectors are a different size). Use a separate collection
for each Ferret (e.g. one for testing).

## Model servers

Ferret talks to models through the OpenAI-compatible API (`/v1/chat/completions`, `/v1/embeddings`, `/v1/rerank`,
`/v1/audio/transcriptions`), so any server that answers it works: Ollama, llama.cpp's `llama-server`, LM Studio,
vLLM. Give each setting just the server's address; a trailing `/v1`, or a path in front for a reverse proxy, is fine.

```ini
VISION_URL=http://gpu.lan:8080      # photos (and embeddings, unless EMBED_URL is set)
VISION_MODEL=qwen3-vl-8b            # the model name the server answers to
EMBED_URL=http://gpu.lan:8081       # optional: embeddings from another server
EMBED_MODEL=qwen3-embedding-8b
AI_API_KEY=…                        # optional: for servers started with an API key
```

- **Ollama** serves every model from one address, so `VISION_URL` alone is enough.
- **llama.cpp**: a plain `llama-server` runs one model. Run one for the vision model (with its `--mmproj`, or photos are
  refused) and one with `--embeddings` for `EMBED_URL` — or one address that picks the model by name (llama-server's
  router mode, or [llama-swap](https://github.com/mostlygeek/llama-swap)). Embeddings are only asked for with
  `QDRANT_URL` set.
- `CHAT_URL`, `RERANK_URL` and `SPEECH_URL` can each be a different server again.
- `AI_API_KEY` is sent as `Authorization: Bearer …` to all of them (llama-server's `--api-key`, LM Studio, vLLM's
  `--api-key`).
- Older setups name `VISION_URL` **`OLLAMA_URL`** — it still works, for any server, and `VISION_URL` wins if both are set.
- Smart search's cut-offs were tuned on `qwen3-embedding`. Another embedding model works, but matches by meaning may be
  a little stricter or looser.

If photos aren't read, Settings → Server lists the service errors with what the model server answered.
