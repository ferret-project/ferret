# The server admin

Some things belong to the whole server rather than one household — backups, recall checks and the service error log. One person looks after them: the
**server admin**. They see **Settings → Server** and get backup alerts in the bell; nobody else does.

It's the **first account** made on the server, until it's handed over:

- In **Settings → Server → Server admin**: enter the email of another account (it must have confirmed its email), and
  confirm. You lose the tab once it's theirs.
- On the server, for when the admin's account is gone or locked out:

  ```bash
  docker compose exec ferret node dist/cli.js admin                    # who it is
  docker compose exec ferret node dist/cli.js admin someone@example.com
  ```

If the admin's account is deleted, it falls back to the oldest account. Server settings never work with an API key.

## Recall checks

**Settings → Server → Recall checks** switches on checking everyone's things against the US Consumer Product Safety
Commission's recalls ([what people see](../guide/recalls)). It's off until you switch it on, because it sends the
**brands** people own (nothing else — not names, models or anything about them) to the CPSC's public recall search at
saferproducts.gov, each brand at most once a week. The answers are kept on the server and every household is checked
against them daily. Switching it off stops the asking; recalls already found stay on the things they were found for.

## Service errors

**Settings → Server → Service errors** lists every failed call to a service Ferret uses — the AI models (Ollama, the
chat model, the reranker), the vector store (Qdrant), the document reader (docling), Apprise, Web Push, the barcode and
recall databases, Apple Maps — with how many times and when. When one starts failing you get told (push, your other
apps, and email if Ferret can send it), at most once every 6 hours per service, and it's in the bell for a day. Ferret
carries on without them where it can (search by words only, photos read later). **Clear all** once it's fixed.

Background jobs that gave up after their last try are listed too ("Background jobs"), and Ferret's own unexpected
errors ("Ferret itself").

The email has a **For triage** part, and each error has **Copy details**: what failed, when (in your household's time
zone), how long the call took, where in Ferret it was called from, what the service said — for an AI model, which model,
why its reply stopped and how many tokens it used — and which server and version this is. Paste it into a bug report,
or to Claude. It never includes what people typed or own: a model's reply is cut down to its first and last few words.
