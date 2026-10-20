---
name: wedding-documents
description: Issue #48 / ADR 0056 — documents: metadata (wedding_document) + bytes as base64 (document_content, never listed) in the SQLite store; type from the signature AND extension; caps per file/wedding/workspace/platform with exact counters; per-request body limit decided before reading (7 MiB only for a live-session upload); downloads as attachment + sandbox CSP
metadata:
  type: project
---

Since issue #48 (2026-10-19): `product/src/documents/document_service.ts`, `product/src/web/multipart_form.ts`.

- **Bytes in the record store**, in a collection that is NEVER listed (`document_content`); the metadata is
  separate. Do not add a `list` over `document_content`: each row is up to ~7 MB.
- **What a file is** comes from its signature, and the name's extension must agree; the client's Content-Type is ignored.
- **Caps** are checked before any write. Workspace and platform totals are counters updated in the same transaction
  as each upload and removal: any new way to delete a document must update them too. The platform cap (256 MiB) keeps
  documents well inside the DB's 1 GiB cap.
- **The edge's body limit is per request:** `ProductWebUi.bodyLimit` grants 7 MiB only to the web upload form, and
  only for a live PLANNER session of the slug's own workspace (`uploadGate`). The JSON route stays at 1 MiB. Never
  raise `MAX_BODY_BYTES` globally.
- **One process budget for bytes in flight** (`TransferBudget`). Every request body and every response is held against
  48 MiB until done (`whenDone`: finish, close OR socket close — Node 22 does not close queued pipelined responses).
  - What does not fit is refused: a body chunk gets a 503; a READ's response gets a 503.
  - A WRITE is checked for room before it runs, and its response is always sent.
  - 12 MiB per download session (`transferKey`).
  - 4 unfinished responses per connection, 256 connections.
  - Timeouts: 120 s to write a large response, 120 s idle, 30 s for headers, 60 s per request.
  - At most 3 large uploads at once, one per workspace.
  - Never bypass `res.end` / `whenDone` in web_server.ts.
- **Downloads** are limited to 60 per session per minute; caps are checked from the base64 length before decoding.
- **Binary I/O:** `ApiRequest.bodyBytes` carries the raw request bytes; `HttpResult.bytes` carries a binary response.
- **Downloads** are only ever attachments, with the type re-checked and a sandbox CSP (`attachmentDisposition` keeps
  the header safe).

Related: [[vendors-per-wedding]], [[durable-storage-record-store]].
