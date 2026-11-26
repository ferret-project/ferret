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

Use a separate `QDRANT_COLLECTION` for each Ferret (e.g. one for testing).

### Changing the embedding model

Ferret remembers which embedding model and which collection made its search index. When you change `EMBED_MODEL`,
`QDRANT_COLLECTION` or `QDRANT_URL` and restart, it notices and embeds every thing again by itself — in the
background, a thing at a time. (It also checks once a day, and embeds anything new or missed since.) If the collection is the same one, the old model's vectors are cleared first, so the
two never mix (a new model's vectors are often a different size anyway). **Settings → Server → Smart search** shows
the model, the collection and how far it has got. Until it's done, smart search only finds the things already
embedded; keyword search works as usual.

A change Ferret can't see from the names — new weights under the same model name, or the same model at another
precision on the same server — needs **Re-index everything** there.

Search's cut-offs were tuned on the default models, so another model may find a little more or less by meaning.

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
- **Thinking models need room.** `qwen3-vl:8b` is the thinking build; on a home GPU with Ollama's default 4,096-token
  window it can run out before answering a photo. `qwen3-vl:8b-instruct` (same size) doesn't think and is faster, or
  raise the window (`OLLAMA_CONTEXT_LENGTH=8192`) — see
  [Troubleshooting](../guide/troubleshooting#some-photos-aren-t-read-ran-out-of-room-or-reply-wasn-t-json-finished-length).
- Older setups name `VISION_URL` **`OLLAMA_URL`** — it still works, for any server, and `VISION_URL` wins if both are set.
- Smart search's cut-offs were tuned on `qwen3-embedding`. Another embedding model works, but matches by meaning may be
  a little stricter or looser.

If photos aren't read, Settings → Server lists the service errors with what the model server answered.

## Ask Ferret

[Ask Ferret](../guide/finding-things#ask-ferret) gives the answering model (`CHAT_URL`'s, else the vision model) the
things and document sections that match the question, as much as fits its **context size** — set it in
**Settings → Server → Ask Ferret** to the context size the model server runs the model with. Each server sets it its own
way, and Ferret can't change it through the API, so it only needs to be told:

| Server | Where its context size is set |
| --- | --- |
| vLLM | `--max-model-len` |
| llama.cpp (`llama-server`) | `--ctx-size` (`-c`) |
| Ollama | `OLLAMA_CONTEXT_LENGTH` on the server, or the model's `num_ctx` |
| LM Studio | the model's **Context Length** when it's loaded |
| A hosted API | the model's context window in its documentation |

The default, 8K tokens, works with nearly every server.

- **Bigger** reads more of a long manual at once (a whole chapter rather than its start) and leaves room for long
  lists of steps, but each question takes longer.
- **Bigger than the model allows** and the model server cuts the question off — the answer then comes from part of the
  manual — or refuses it (a service error). Some servers (Ollama, llama.cpp) cut silently, so match their setting.
- How-to questions keep more room for the reply (a quarter of the size, up to 4,096 tokens), so they read a little less.

The card shows about how many characters a question reads with the size chosen. Ferret estimates tokens from
characters (about three a token), so leave some headroom for text that isn't English.

## AI prompts

**Settings → Server → AI prompts** (the server admin) lets you add your own instructions to the end of what Ferret asks
its models, one prompt at a time: photos of things, documents, Describe it, room scans and Ask Ferret. Pick a prompt,
look at **Ferret's built-in prompt** (household details such as categories show as placeholders), and write your
instructions underneath — for example:

- *Photos of things:* "For trading cards, put the set name and card number in the model, like Base Set 4/102."
- *Ask Ferret:* "Answer in British English."

Your instructions are **added to** Ferret's, never replace them: the reply's format, what Ferret counts as sure enough
to fill in by itself, and improvements to the prompts in later releases all still apply. They're used for every
household on the server.

- A small model follows a long list of extra rules less well than a short one — keep them to a line or two.
- Instructions that contradict Ferret's ("always guess the price") make answers worse rather than better.
- **Reset to default** removes them. The [server check](server-check) lists prompts that have extra instructions, so
  they're easy to find when AI answers look odd.

The search judge's prompt isn't offered: it was chosen by measuring search results, and changing it would quietly make
search worse.
