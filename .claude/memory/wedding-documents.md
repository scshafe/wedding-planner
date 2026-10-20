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
- **The edge's body limit is per request:** `ProductWebUi.bodyLimit` grants 7 MiB only to the two upload routes and
  only with a live session (via `CsrfGuard.issueCsrf`). Never raise `MAX_BODY_BYTES` globally.
- **Binary I/O:** `ApiRequest.bodyBytes` carries the raw request bytes; `HttpResult.bytes` carries a binary response.
- **Downloads** are only ever attachments, with the type re-checked and a sandbox CSP (`attachmentDisposition` keeps
  the header safe).

Related: [[vendors-per-wedding]], [[durable-storage-record-store]].
