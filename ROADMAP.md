# Roadmap: the planner workspace

The product direction the engineering loop builds toward. The owner set it on 2026-10-13 (a full
planner workspace, not a narrow wedge). The triage agent keeps this file current; changes in
direction (target customer, pricing, business model) are the owner's call (`status:needs-owner`).

## Who it is for

- **The paying customer: independent wedding planners and small studios** (1–10 planners, roughly
  5–40 weddings a year). They run every wedding from one workspace, branded as their own business.
- **Their clients: couples.** Invited by the planner into their own wedding: they see and edit
  what the planner shares with them.
- **The couple's guests.** They never log in: they use a wedding website, an RSVP link and, later,
  text messages answered by the AI.

The job, in the planner's words: *"keep every wedding on track without chasing my couples, my
vendors and 150 guests by hand."*

## Where we are (2026-10-19, M2 done)

M1 and M2 are done. On top of M1's secure multi-tenant workspace (durable storage, real accounts, invitations, the
outbox and operator console, feedback, operability), a wedding now has its planning core:
- a guest list of households and guests with plus-ones, CSV import and export;
- events with per-event RSVPs and meal choices, and a public RSVP page per household (a link stored only as a hash);
- a checklist from a built-in template, the date-move shift, and the planner's overdue / due-this-week view;
- vendors with payment schedules in integer cents, and a budget whose lines can follow a vendor's schedule.

The couple sees its own wedding: what the planner shares, and what is the couple's to do. Every M2 change had a
security review before it landed, and the reviews' findings are fixed (1400 tests). Production still runs in demo
mode: the demo tenant keeps its labeled role picker, every other workspace signs in for real.

Next is M3 (event day and guest experience: #45 run of show, #46 seating, #47 wedding website, #48 documents), then
M4 with the model port's simulated adapter only. Guest Q&A is still keyword matching until M4.

## Milestones

Build them roughly in order. Within a milestone the triage agent sequences by dependency and
value; an item that turns out larger than one PR is split into issues.

### M1: Real foundations — done (2026-10-19)

Someone can use it for real and find their work there tomorrow. Shipped as #8 (storage), #9 (outbox and
operator console), #10 (accounts), #11 (invitations), #12 (feedback) and #13 (operability); ADRs 0039–0044.

- **Durable storage.** A persistence port with a file-backed adapter (e.g. SQLite) under the
  stack's `./state` volume; schema migrations; the in-memory adapter stays for tests; the
  stack's `[backup] paths` include the data. A deploy must no longer wipe data.
- **Real planner accounts.** Email + password (a slow hash), persisted sessions, sign out,
  password reset. The simulated role picker goes away outside demo mode.
- **Email outbox.** An email port with a simulated adapter that records every message in an
  operator-visible outbox (offline-first; a real provider is an owner crossing in M5).
- **Invitations.** A planner invites teammates and a couple (one-time link via the outbox);
  roles: owner, planner, couple.
- **In-app feedback.** A "Send feedback" form for planners and couples, stored durably and
  visible to the operator. Owner decision (ADR 0045): it stays in the app. The operator reads it
  in the console and files issues by hand; nothing users write goes to GitHub or an agent
  automatically.
- **Operability.** Structured request logs, an operator page of recent server errors, the build
  commit in `/healthz`.

### M2: Planning core — done (2026-10-19)

The planner's daily work happens here. Shipped as #27 (guest list), #28 (CSV), #29 (events and RSVPs), #30 (household
RSVP page), #31 (checklist), #32 (due across weddings), #33 (vendors), #34 (budget) and #41 (invitation provenance);
ADRs 0046–0052 and the ADR 0039 addendum (grouped keys).

- **Guest list.** Guests with names, households/parties, contact details, side, tags, plus-ones,
  dietary needs; CSV import and export.
- **RSVPs.** Per-event RSVP and meal choice; a themed RSVP page reached by a per-household link;
  live counts for the planner and the couple.
- **Checklist and timeline.** Task templates scheduled by months-before-the-wedding, due dates,
  assignee (planner or couple), status; an "overdue and due this week" view across weddings.
- **Vendors.** Per wedding: category, contact, contract status, deposit and payment schedule.
- **Budget.** Categories with estimated vs actual, payments due, linked to vendors; the couple
  sees what the planner shares.

### M3: Event day and guest experience

- **Events and run of show.** Several events per wedding (rehearsal, ceremony, reception); a
  day-of timeline with times, owners and vendor call times.
- **Seating.** Tables with capacity; assign guests and households; printable table list.
- **Wedding website.** A public, themed page per wedding: schedule, travel and hotel blocks, FAQ,
  registry links, RSVP.
- **Documents.** Attach files (contracts, floor plans) to a wedding or a vendor.

### M4: AI planning assistant

- **A model port** with a simulated adapter (deterministic, for tests and the demo) and a real
  model adapter that is off unless the owner supplies a key (an owner crossing).
- **Guest concierge.** Answer guest questions from the facts guests may see (the allow-list in
  `projectGuestVisibleFacts`, extended with schedule, travel and FAQ), escalate the rest to the
  existing inbox; an eval set in `eval-harness/` scores accuracy and refusals.
- **Planner copilot.** Draft a checklist and timeline from a wedding's details; a weekly "what is
  at risk" summary per wedding.

### M5: Launch readiness (mostly owner crossings)

The agents build each item up to the line; the owner decides and switches it on.

- Self-serve signup and trial (the slug-occupancy oracle and abuse controls need a design).
- Stripe billing behind the existing billing ledger (owner: account, prices, tax).
- Real email and SMS providers behind the existing ports (owner: accounts, US A2P 10DLC
  registration for texting).
- Terms of service, privacy policy, data export and deletion (owner: legal review).
- Custom domains per planner (owner: DNS, certificates).
- Production operations: verified backups and restores, alerting, uptime.

## Business readiness (owner track)

Agents may research and draft these as documents under `docs/business/` for the owner to decide
(`status:needs-owner`): interviews with 5+ planners, competitive positioning against existing
planner software, pricing and packaging, the legal entity, and messaging compliance.

## How the loop uses this file

- The triage agent turns the current milestone into GitHub issues with acceptance criteria,
  keeps 3–6 of them `status:ready`, and opens the next milestone when one closes.
- Feedback (real or synthetic) can reorder work inside a milestone; it changes the milestones
  themselves only through a proposal to the owner.
- The engine domains (`eval-harness/`, `telemetry/`, `loop-orchestrator/`) are kept green and
  extended only where a milestone needs them (M4's eval set). They wait for real usage data.
