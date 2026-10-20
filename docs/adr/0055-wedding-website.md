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
- **A cancelled wedding:** its site is not public either.
- **No rate limit on public reads.** The edge has no client identity, so a limit would be one shared by every guest, and
  an anonymous client could trip it to take the site down for everyone (the security review showed 600 reads did). The
  household RSVP page's limits (ADR 0049) work because they are keyed on a secret link; a site name is public. A read
  costs a few point reads plus the wedding's events (at most the event limit), so there is nothing to protect that a
  shared limit would protect better than it harms.
- **Headers:** the page is sent with `no-referrer`.

### Links are https only

Booking and registry links must parse as `https:` URLs, with no credentials, spaces or quotes, at most 500
characters. The schema pins the same pattern. The page renders them with `rel="noopener noreferrer nofollow"`, and
every text is escaped.

### Who edits

The boundary is the wedding's (`assertWeddingReach`). The planner and the couple both edit the site and publish it.
Publishing needs a saved site. The editor page lists the wedding's events to choose from.

**Name changes are limited:** 10 per wedding per hour. Every attempt to change the name counts, taken or not, and the
count happens before the name is looked up; saving the content under the same name is free. A taken name is an honest
409, also to the couple. That tells a couple that another wedding of the workspace holds a name, even a draft's, so
the limit keeps such probing slow (an accepted residual, like the workspace slug index).

### Routes and pages

- **JSON:** `GET|PUT …/weddings/:id/site` and `PUT …/site/published {published}`.
- **Web:** the editor `?wedding=<id>&tab=site` and a link from the wedding page. The editor's rows are indexed fields
  bounded by the limits, and every form checks the per-session CSRF token first. The public page is
  `/t/<slug>/w/<name>`.

## Consequences

- **Published means readable by anyone who can reach the service.** Site names are short and can be guessed, so a
  published page (hotel block codes included) is public. The editor says so.
- **The couple publishes without the planner's approval**, under the planner's brand, as it makes RSVP links
  (ADR 0049). A planner switch to turn a site off could come later.
- **A site cannot be deleted.** Renaming frees its old name, and unpublishing takes it offline.

- M4's guest concierge can answer from the same allow-listed facts (schedule, travel, FAQ).
- Not done: custom domains, photos, and password-protected sites.
