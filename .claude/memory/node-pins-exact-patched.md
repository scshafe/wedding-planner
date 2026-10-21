---
name: node-pins-exact-patched
description: Node is pinned to an exact patched release in every place (Dockerfile base images, ci.yml and deploy.yml setup-node, engines floor) because deploy builds do not --pull; bump all of them together on a Node security release
metadata:
  type: project
---

Since the owner's security update of 2026-10-21 (Node 22.23.4, the 2026-10-20 security release), the Node pins are
exact. Every place:

- `Dockerfile`: both stages `FROM node:22.23.4-slim`.
- `.github/workflows/ci.yml` and the project-owned toolchain block of `deploy.yml`: `node-version: "22.23.4"`. Keep the
  two equal; `dev check .` accepts edits inside `scshafe-dev:begin/end toolchain`.
- `package.json` `engines`: `>=22.23.4`.

**Why:** the host's deploy builds do not `docker build --pull`. A floating tag such as `node:22-slim` would keep reusing
the stale cached base image after a security release.

**How to apply:** on a Node security release, move all of these to the patched release of the line in one PR. Check
that the tag exists on Docker Hub first: a missing tag breaks the deploy.

**Lockfile:** npm 10 (Node 22's npm) crashes in arborist `#loadPeerSet` ("Cannot read properties of null (reading
'edgesOut')") when it re-resolves vitest's peer set. Regenerate the lockfile with npm 11 (Node 24), then prove it
under CI's toolchain with `npm ci` on Node 22.

Related: [[durable-storage-record-store]], [[deployable-image-composition-root]].
