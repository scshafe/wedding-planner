---
name: wedding-website
description: Issue #47 / ADR 0055 — wedding_site (one per wedding) + wedding_site_name index (unique per workspace, [a-z0-9-] so never id-like); public /t/<slug>/w/<name> via API /t/<slug>/site/<name>, published only, allow-listed view (no guest data), https links only, 600 reads/10 min per site
metadata:
  type: project
---

Since issue #47 (2026-10-19): `product/src/site/site_service.ts`.

- Public content comes ONLY from `publicView`'s allow-list (couple name, date, welcome, public events' name/time/place,
  travel, hotels, FAQ, registry). Never add guest data, counts or ids there.
- Unknown / unpublished / malformed / other workspace / suspended → the generic not-found (no oracle); the rate limit
  applies after the name resolves.
- Links: `https:` only, no credentials, no spaces/quotes (service check + schema pattern); rendered with
  rel="noopener noreferrer nofollow".
- Site names: `SITE_NAME` regex; the index `wedding_site_name` (key = name) keeps them unique; renaming frees the old.

Related: [[household-rsvp-page]], [[events-and-rsvps]].
