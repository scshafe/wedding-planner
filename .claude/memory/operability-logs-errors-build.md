---
name: operability-logs-errors-build
description: Issue #13 / ADR 0044 — request log lines carry only the allow-listed route PATTERN (never query/ids/headers/bodies); 500s are recorded by code + stack frames, NEVER the message; /healthz reports the commit from WP_BUILD_COMMIT or the WP_IMAGE_REF tag
metadata:
  type: project
---

Since issue #13 (2026-10-19):

- **Request log** (`operability/request_log.ts`): the socket adapter writes `{ts, method, route, status, duration_ms,
  tenant?}` per response. `route` masks every segment not in `STATIC_SEGMENTS` (add new static route names there,
  or they log as `:id` — harmless). Never log a path, query, header, cookie or body.
- **Error log** (`operability/error_log.ts`): only 500s; code (`DOMAIN.FAILURE_MODE` or `UNHANDLED.<Name>`) + class
  name (identifier-shaped) + ≤5 stack frames + route pattern. NEVER the error message (messages embed data). V8 puts
  every line of the message at the head of `error.stack`: frames are taken only AFTER the header lines and must match
  the location shape. STORAGE_FAILED is not written back to the failing store. Recorded in
  `ProductApi.handle`'s catch, i.e. OUTSIDE the rolled-back request transaction. Operator reads `/admin/errors`.
- **/healthz** `{status, commit}`: `WP_BUILD_COMMIT` (Docker build arg) else the tag of `WP_IMAGE_REF` (the stack passes
  `${WEDDING_PLANNER_IMAGE}`, i.e. `wedding-planner:<short sha>`) else `unknown`; hex only.

Related: [[durable-storage-record-store]], [[operator-console-and-email-outbox]].
