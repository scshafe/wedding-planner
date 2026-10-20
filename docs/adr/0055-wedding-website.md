# ADR 0055 — The wedding website

- **Status:** accepted
- **Date:** 2026-10-19
- **Decider:** the building agent (an agent-owned engineering decision per [[agents-own-buildout-decisions]]),
  for issue #47 (M3 "Event day and guest experience")
- **Scope:** a public, themed page per wedding for guests: when, where, how to get there, where to stay, and how to
  RSVP. The second public page, after the household RSVP page (ADR 0049).

## Decision

### Two contracts

- **`wedding_site`:** one per wedding, keyed by the wedding id. It holds:
  - the site name and whether it is published;
  - a welcome and travel notes;
  - which of the wedding's events are public;
  - hotel blocks (name, address, booking link, block code, book-by date);
  - an FAQ;
  - registry links.

  Each list is bounded: 10 hotels, 30 questions, 10 links, 12 events.
- **`wedding_site_name`:** the workspace's index of site names (keyed by name, naming the wedding). A name is unique in
  the workspace, and the public page finds its wedding by it. Renaming frees the old name.

### Site names

3 to 40 lowercase letters, digits and hyphens, starting and ending with a letter or digit. There is no underscore,
so a site name never looks like an id. The couple or the planner chooses it, and a taken name is a 409.

### What the public sees: an allow-list

`SiteService.publicView` builds the public content from fields it names:
- the couple's display name and the date;
- the welcome;
- the public events (name, time and place only);
- travel notes, hotels, the FAQ and registry links.

It never includes a guest, a count, an RSVP, or any id but the site's own. The page also explains that guests
answer with their household's RSVP link (#30), and lists no one.

### Public and masked

- **The route:** the browser page is `/t/<slug>/w/<site-name>`. It goes through the pipeline's public
  `/t/<slug>/site/<name>` read.
- **No existence oracle:** a malformed name, an unknown or unpublished site, another workspace's site, and a
  suspended workspace are all the generic not-found.
- **Rate limit:** reads of one published site are limited to 600 per ten minutes. The limit applies only after the
  name resolves, so an unknown name costs one point read.
- **Headers:** the page is sent with `no-referrer`.

### Links are https only

Booking and registry links must parse as `https:` URLs, with no credentials, spaces or quotes, at most 500
characters. The schema pins the same pattern. The page renders them with `rel="noopener noreferrer nofollow"`, and
every text is escaped.

### Who edits

The boundary is the wedding's (`assertWeddingReach`). The planner and the couple both edit the site and publish it.
Publishing needs a saved site. The editor page lists the wedding's events to choose from.

### Routes and pages

- **JSON:** `GET|PUT …/weddings/:id/site` and `PUT …/site/published {published}`.
- **Web:** the editor `?wedding=<id>&tab=site` and a link from the wedding page. The editor's rows are indexed fields
  bounded by the limits, and every form checks the per-session CSRF token first. The public page is
  `/t/<slug>/w/<name>`.

## Consequences

- M4's guest concierge can answer from the same allow-listed facts (schedule, travel, FAQ).
- Not done: custom domains, photos, and password-protected sites.
