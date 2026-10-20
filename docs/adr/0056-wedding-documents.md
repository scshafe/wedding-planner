# ADR 0056 — Documents for a wedding or a vendor

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]),
  for issue #48 (M3 "Event day and guest experience")
- **Scope:** files attached to a wedding or one of its vendors (contracts, floor plans, quotes): upload, list, share
  with the couple, download. The product's first binary data and its first file responses.

## Decision

### The bytes live in the record store

A document is two records under the same key, `groupedKey(wedding_id, document_id)`:
- **`wedding_document`:** the metadata, under a JSON Schema contract. It holds the title, the kind (contract, floor
  plan, quote, other), the optional vendor, the uploaded file name, the content type, the size, the SHA-256 and
  whether it is shared with the couple.
- **`document_content`:** the bytes as base64. This record is read one at a time by key and never listed, so a list
  of documents never decodes a file.

Both are rows of the same SQLite file as the rest of the state (ADR 0039). Several things follow from that:
- **Backup:** the stack's `[backup] paths = ["state/app"]` already covers documents, so the backup's scope does not
  change. Its size grows (see "Storage bounds").
- **Atomic uploads:** a request is one transaction, so an upload writes its metadata, its bytes and the usage counters
  together or not at all. A failed request leaves no orphan file.
- **Rollback safety:** the change adds new collections only. An older build ignores them.

**Rejected: files on disk next to the database.** They would be smaller (no base64), but they would not be
transactional with the metadata, they would need their own path handling, and they would need a second backup
consistency story. The base64 overhead (a third) is paid within the caps below.

### What a file is: decided from its bytes

Only PDF, PNG and JPEG are accepted:
- **Signature:** the type is the one the file's signature declares (`%PDF-`, the PNG signature, `FF D8 FF`).
- **Name:** the file's name must end with that type's extension (`.pdf`, `.png`, `.jpg`/`.jpeg`). Both checks must
  agree.
- **What is stored:** the stored content type comes from the signature. The browser's declared Content-Type is
  ignored, and only the last segment of the file name is kept.

### Storage bounds

Every bound is checked before anything is written:

| Bound | Limit |
| --- | --- |
| One file | 5 MiB (the contract's `size_bytes` maximum) |
| One wedding | 40 files and 25 MiB |
| One workspace | 100 MiB |
| The platform | 256 MiB of files |

- **How they are checked:** the file's exact size comes from its base64 length and padding, so every cap is checked
  before any scan or decoding, and an upload to a full store costs almost nothing. The workspace and
  platform totals are counters (`document_workspace_usage`, and the global `document_platform_usage`) kept in the same
  transaction as each upload and removal, so they are exact and cost one read each.
- **Why a platform cap:** it keeps documents (about 341 MiB once base64-encoded) well inside the database's own 1 GiB
  cap. A full document store therefore refuses uploads and nothing else.

### Who does what

The boundary is the wedding's (`assertWeddingReach`).
- **The planner** uploads, edits (title, kind, vendor, sharing) and removes documents.
- **The couple** lists and downloads only shared documents. What the couple sees is built from an allow-list: no
  original file name, no hash, and no vendor name for a vendor the couple is not shared (as on the vendors page,
  ADR 0051). The download name is `<title>.<ext>`.
- **Masked not-found:** another wedding's document, an unknown id, and an unshared document asked for by the couple are
  all the same not-found.
- **Integrity:** the bytes are checked against the stored hash on download, so a damaged record is an error, never a
  wrong file.
- **Download limit:** 60 downloads per session per minute. Each one reads and decodes up to 5 MiB, and a limit keyed
  on the session, never on a public value, only slows that session.

### Uploads: the edge, then a bounded parser

- **The edge's body limit is per request now.** `ProductWebUi.bodyLimit(method, path, headers)` is decided before the
  body is read:
  - Every request keeps the 1 MiB default, except the web form `POST /t/:slug/documents/upload`.
  - The form gets 7 MiB only when its session cookie is a live **planner** session of **that slug's** workspace
    (`uploadGate`). An anonymous client, a couple, or another workspace's planner therefore never makes the server
    hold more than the default.
  - A declared `content-length` over the limit is refused before any body is read.
  - A storage failure while checking the session falls back to the default, never a crash outside the handler.
- **The JSON upload route keeps the 1 MiB default.** The form reaches it in-process, and parsing a 7 MiB JSON body is
  a heap and event-loop risk of its own (security review). An API client can send files up to about 750 KB as base64
  JSON. A raw-bytes route could come later if one needs more.
- **Large uploads are limited.** At most 3 large upload bodies are received at once, and at most one per workspace
  (503 with `Retry-After` otherwise), so no workspace takes every place. Each body must arrive within 60 seconds
  (408).
- **The web adapter passes a multipart body's raw bytes** (`ApiRequest.bodyBytes`), not a UTF-8 copy nobody reads.
  Every other body is the UTF-8 `rawBody`, as before.
- **The form is `multipart/form-data`**, parsed by `multipart_form.ts`. The parser:
  - takes RFC 2046's boundary from the header;
  - does one forward pass with `Buffer.indexOf`;
  - accepts at most 12 parts, 1 KiB of headers per part, 4 KiB per text field and one file;
  - treats anything malformed as one refusal.

  CSRF is checked on the parsed form before anything else. A form that does not parse has no token, so it gets the
  masked 403. The file then goes to the JSON route as base64, so the JSON API stays the only data path.

### Bytes in flight: one budget for the process

The security review showed that one couple session could pipeline 100 downloads of a 5 MiB document without reading
them, and make the process hold over 500 MB: an out-of-memory kill of the 512 MiB container, for every tenant. Two
re-reviews then closed the gaps. So, in `web_server.ts` and `TransferBudget`:
- **Everything is held.** Every request body (chunk by chunk, as it arrives) and every response is held against one
  48 MiB budget until the exchange is done: written, closed, or its connection closed (`whenDone`).
  - The connection matters: on Node 22 (production), a pipelined response still queued behind another never emits
    `close` when the connection dies (Node 24 does). Releasing only on the response's own `close` leaked the budget
    permanently.
- **What does not fit is refused, never half-applied.**
  - A body chunk that does not fit ends its request (503, connection closed).
  - A read (GET/HEAD) whose response does not fit gets a 503 instead.
  - A write is checked for room before it runs; once applied, its response is always sent (the budget may be passed
    by that one response), so a 503 never follows a change that happened.
  - Deferred work runs after every response, refused ones included.
- **One session cannot hold it alone.** A download is held under its session's key, at most 12 MiB per key (two full
  documents), checked before anything is read.
- **Time is bounded.**
  - A large response (256 KiB or more) must be written within 120 seconds, or the connection is dropped.
  - Any connection idle for 120 seconds is closed.
  - Headers must arrive within 30 seconds and the whole request within 60.
- **Connections are bounded.** One connection may have at most 4 unfinished responses (browsers and the serving proxy
  send one at a time; a client that pipelines more is dropped, with everything it queued). The server accepts at most
  256 connections, which also bounds the kernel buffers the budget cannot see.

**The trade:**
- **The cost of the bound.** A client that keeps holding the budget gets everyone's large downloads and reads 503s
  for as long as it keeps it up: a denial, not an out-of-memory kill. It is bounded per session, so it takes several
  sessions. On a real workspace sessions need passwords; on the demo workspace anyone can open them.
- **Where the per-connection cap applies.** In production the serving proxy does not pipeline, so the cap is reached
  only by direct connections.

### Downloads: never a page of this origin

`GET /t/:slug/documents/download?wedding=<id>&doc=<id>` (the web UI) reads the JSON download route, which returns the
bytes as base64 and decides who may have them. The UI sends the file (`HttpResult.bytes`) with:
- `content-type`: the sniffed type, one of the three, re-checked;
- `content-disposition: attachment`, with an ASCII `filename` (anything outside a safe set becomes `_`, so no quote,
  CR, LF or `;` reaches the header) and the exact name as RFC 5987 `filename*`;
- `x-content-type-options: nosniff`, `cache-control: no-store`;
- `content-security-policy: default-src 'none'; sandbox`;
- `cross-origin-resource-policy: same-origin`, `referrer-policy: no-referrer`.

### Routes and pages

- **JSON:** `GET|POST …/weddings/:id/documents` and `GET|PUT|DELETE …/documents/:id`. A file that is too large is a
  413 and an unaccepted type a 415, honest answers to the planner after the boundary and the capability. A full store
  is a 409.
- **Web:** `?wedding=<id>&tab=documents`, linked from the wedding page:
  - one document is edited at a time (`&doc=<id>`), so the page does not repeat the vendor list per document;
  - the upload form posts to `/t/:slug/documents/upload`;
  - the edit forms post to `/t/:slug/documents/doc-save|doc-remove`.

## Consequences

- **What the owner should know:**
  - The backup's scope is unchanged (`state/app`).
  - The database, and so each backup copy, can grow by up to about 350 MB of documents.
  - SQLite does not shrink its file when documents are removed: the space is reused, and the file stays at its
    high-water mark.
- **Over 7 MiB:** an upload is refused by the edge with a 413 and the connection closed. Behind the proxy, a browser
  may show a reset rather than the 413. A file between 5 and 7 MiB gets the "at most 5 MB" notice.
- **Snapshots:** each future schema migration first writes a `.pre-vN.sqlite` snapshot next to the database (ADR
  0039). With documents, a snapshot can be up to about 350 MB, snapshots are not pruned, and they keep documents that
  were later removed (`secure_delete` reaches only the live file). The owner should prune old snapshots after a
  migration has proven good.
- **The platform cap is shared:** three full workspaces (100 MiB each) would fill the 256 MiB cap for everyone. Near
  the cap, a 409 while a planner's own wedding and workspace are under theirs reveals roughly how full the platform
  is: an aggregate, coarse signal about other tenants (accepted). An operator alert or per-workspace reservations
  could come with real usage.
- **Vendor removal:** a vendor removed later leaves its documents on the wedding, shown without a vendor name.
- **Not done:** previews, versioning and e-signatures (out of scope in the issue).
