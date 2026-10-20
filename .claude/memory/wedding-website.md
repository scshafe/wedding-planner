---
name: wedding-website
description: Issue #47 / ADR 0055 — wedding_site (one per wedding) + wedding_site_name index (unique per workspace, [a-z0-9-] so never id-like); public /t/<slug>/w/<name> via API /t/<slug>/site/<name>, published only, allow-listed view (no guest data), https links only, public reads unlimited (a shared limit is a denial lever), name changes 10/h per wedding
metadata:
  type: project
---

Since issue #47 (2026-10-19): `product/src/site/site_service.ts`.

- Public content comes ONLY from `publicView`'s allow-list (couple name, date, welcome, public events' name/time/place,
  travel, hotels, FAQ, registry). Never add guest data, counts or ids there.
- Unknown / unpublished / malformed / other workspace / suspended / cancelled wedding → the generic not-found (no
  oracle).
- Public reads are deliberately NOT rate-limited: with no client identity a limit is shared by every guest, so an
  anonymous client could trip it to take the site down (#47's security review). Never key a limit on a public value.
- Name changes ARE limited (`SITE_NAME_CHANGES`, 10 per wedding per hour, counted before the lookup): a taken name is
  an honest 409, also to the couple, so the limit bounds probing.
- Hotels in the public view are copied field by field (`PublicHotel`), never by spreading the stored record.
- Links: `https:` only, no credentials, no spaces/quotes (service check + schema pattern); rendered with
  rel="noopener noreferrer nofollow".
- Site names: `SITE_NAME` regex; the index `wedding_site_name` (key = name) keeps them unique; renaming frees the old.

Related: [[household-rsvp-page]], [[events-and-rsvps]].
