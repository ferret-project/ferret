# AI features

Every AI feature is optional and runs on **your own models** — nothing about your things is sent to an outside AI
service. Each switches on when its setting is present; without them Ferret is a plain (and fast) inventory.

AI work happens in the background, one job at a time per kind, retried if a model is busy. **Nothing a model says is
applied by itself**: it becomes suggestions a person taps to accept.

| Feature | Needs | What it does |
|---|---|---|
| Reading photos | `OLLAMA_URL` (a vision model, e.g. `qwen3-vl:8b`) | Describes each photo, reads text on it, suggests name, brand, model, serial number. Lists the things in a [room scan](../guide/room-scan) and where they are. |
| Reading documents | `DOCLING_URL` ([docling-serve](https://github.com/docling-project/docling-serve)); optionally `DOCLING_VLM_URL` | Turns PDFs and photos of paper into text, for search and suggestions. With `DOCLING_VLM_URL` (granite-docling behind an OpenAI-compatible API, e.g. vLLM), pages are read by that model instead of docling's standard pipeline. |
| Stronger answers | `CHAT_URL` (any OpenAI-compatible API, e.g. vLLM) | Ask Ferret, and reading receipts, warranties and manuals. Without it, the vision model does this too. |
| Smart search | `QDRANT_URL` + `OLLAMA_URL` (`EMBED_MODEL`) | Finds things by meaning, including inside documents. |
| Reranking | `RERANK_URL` | Better ordering of search results. |

Changing `EMBED_MODEL` needs a new `QDRANT_COLLECTION` (the vectors are a different size). Use a separate collection
for each Ferret (e.g. one for testing).
