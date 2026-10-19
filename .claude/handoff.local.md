# Handoff

Interactive-session context. The loop's roles keep their continuity on GitHub (issues, PRs) and in
`~/.wedding-planner-loop/journal.jsonl`; this file is for a human-driven session picking things up.

## Where things stand (2026-10-19)

- **M1 "Real foundations" is built** (owner request, interactive session, 2026-10-19): #8 durable storage (ADR 0039),
  #9 email outbox + operator console (0040), #10 real accounts (0041), #11 invitations (0042), #12 in-app feedback
  (0043), #13 request logs / error page / build commit (0044). Each landed as its own PR, reviewed by the in-repo
  `security-reviewer` (and `architecture-reviewer` for #8), with every must-fix applied; each merge deployed to the
  laptop through the runner lane and passed the host's `/healthz` witness.
- **Production** stays in demo mode (the demo tenant keeps its labeled role picker; every other workspace has real
  sign-in only) and now keeps its data in `state/app/wedding-planner.sqlite` (backed up). The operator console is at
  `/admin` (sign in with `WP_OPERATOR_TOKEN`): Tenants (set up owners), Outbox (simulated email), Feedback, Errors.
- **Owner decisions still open:** how feedback reaches the agents (#12 out of scope), a real email provider (M5),
  `WP_PUBLIC_URL` for absolute links in emails, #14–#16 (loop timers, old Mac loop, `main` protection).
- **Next:** M2 "Planning core" in `ROADMAP.md` (guest list, RSVPs, checklist, vendors, budget). Durable-storage rules
  for new records: [[durable-storage-record-store]] (add every collection to the census; ship new fields
  expand-then-contract; never regenerate a drift fixture).
- **Dashboard:** the reporter publishes it to GitHub Pages once the owner turns Pages on (unchanged).
- **Last product work before M1:** Phase 38, the guest-conversation transcript (ADR 0038).

## Standing rails (unchanged — do not weaken)
Offline-first (no real money/booking/comms; no prod/credentials — don't simulate them). **A real messaging
provider sending real texts is the human crossing (guest-comms tier-2 / exception #4) — build up to the line,
never across it or simulate having.** Don't modify `ops/` or `CLAUDE.md` (human-reserved). Push only to this
repo's `origin`. The review sub-agents now ship in-repo (`.claude/agents/`: security-reviewer, test-reviewer,
architecture-reviewer); the old doddy/testineer/rigorous-architect/wolf personas were never provisioned on this host. **CI/exit-code lesson:** never pipe `npm run build`/`npm run
lint` to tail/grep when gating with `&&` (the pipe masks the non-zero exit). NOTE: this is **zsh** — `PIPESTATUS`
is not set; use `cmd > /tmp/x.log 2>&1; echo $?` or zsh's `$pipestatus` (1-indexed). `npm run build` runs from
REPO ROOT. **Eval-harness/telemetry import ONLY `@wedding-planner/shared`, never `product`** (the firewall, by
reachability). **Schema MODIFY ⇒ `npm run gen:types`** (a NEW schema file additionally bumps the manifest count
test + title prose + the gen-script header — Phase 37 only MODIFIED `escalation_resolution`, so the manifest is
still **21**). **The guest responder's security boundary is `projectGuestVisibleFacts`'s allow-list.**
**Web-form mutations are CSRF-gated at the web layer ONLY** (the JSON API is Bearer-only / not CSRF-reachable).
**The web UI's ONLY data path is `api.handle()`.** **Guest/manage/billing scope comes from the MINTED
principal/context, never the request body; a guest is UNTRUSTED (no Principal) bound to ONE wedding by the
registry.** **When a side-effect splits across two logs by a runtime decision, dedup across BOTH before the write
(§B0).** **A client/provider-controlled value used as a tenant-partitioned KEY is safe (inert-or-self-harm); a
value used to SELECT a routing target must intersect TRUSTED axes (from_ref ∧ live binding.wedding_id), never a
body field.** **A status MACHINE over an append-only log = effective-status FOLD over the highest-`seq`
transition; directional no-op for idempotency, NOT a client seq — unlike a true append (escalation_reply) which
needs the client seq + a 409 lost-update arbiter.** **A reopen-candidate / routing POLICY belongs in the
SELECTOR, not in the status primitive (`transition()` is permissive by design — Phase 37).**
