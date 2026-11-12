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
| Reading documents | `DOCLING_URL` ([docling-serve](https://github.com/docling-project/docling-serve)); optionally `DOCLING_VLM_URL` | Turns PDFs and photos of paper into text, for search and suggestions. With `DOCLING_VLM_URL` (granite-docling behind an OpenAI-compatible API, e.g. vLLM), pages are read by that model instead of docling's standard pipeline. When docling finds little or no text in a PDF (a scanned receipt or warranty card), the vision model reads its first page too. Without docling, the vision model reads PDFs' first pages on its own. |
| Stronger answers | `CHAT_URL` (any OpenAI-compatible API, e.g. vLLM) | Ask Ferret, and reading receipts, warranties and manuals. Without it, the vision model does this too. |
| Smart search | `QDRANT_URL` + `OLLAMA_URL` (`EMBED_MODEL`) | Finds things by meaning, including inside documents. |
| Reranking | `RERANK_URL` | Better ordering of search results. |
| [AI helpers](../guide/ai) | `CHAT_URL` or `OLLAMA_URL` | Sorting imports, filters from plain words, replacement-cost estimates, typical upkeep. Possible duplicates by meaning also need smart search. |
| Speech to text | `SPEECH_URL` (an OpenAI-compatible `/v1/audio/transcriptions`, e.g. [speaches](https://github.com/speaches-ai/speaches) or vLLM with Whisper) | Saying a thing's name on a walkthrough. |

Changing `EMBED_MODEL` needs a new `QDRANT_COLLECTION` (the vectors are a different size). Use a separate collection
for each Ferret (e.g. one for testing).
