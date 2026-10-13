# Handoff

Interactive-session context. The loop's roles keep their continuity on GitHub (issues, PRs) and in
`~/.wedding-planner-loop/journal.jsonl`; this file is for a human-driven session picking things up.

## Where things stand (2026-10-13)

- **The engineering loop v2 is set up** (PR "Engineering loop: agent roles over GitHub Issues, with a
  dashboard"): six roles in `ops/loop/`, explained in `ops/AUTONOMOUS_OPERATION.md`, memory
  [[engineering-loop-v2]]. Labels, milestones (M1–M5, Business readiness) and the seed backlog exist on
  GitHub.
- **Waiting on the owner:** #14 install the systemd timers, #15 confirm the old Mac LaunchDaemon is
  unloaded, #16 a ruleset protecting `main`, and turning on GitHub Pages for the dashboard. Until #14,
  nothing runs on a schedule.
- **Product direction:** full planner workspace, `ROADMAP.md` ([[product-direction-full-planner-workspace]]).
  M1 is shaped and ready: #8 durable storage → #9 email outbox → #10 accounts → #11 invites,
  #12 in-app feedback, #13 operability.
- **Dashboard:** the reporter publishes it to GitHub Pages (https://scshafe.github.io/wedding-planner/,
  the `gh-pages` branch) once the owner turns Pages on. A private claude.ai copy
  (`WP_DASHBOARD_URL` in `~/.wedding-planner-loop/config.env`) can only be refreshed from an
  interactive session: headless runs have no Artifact tool.
- **Last product work:** Phase 38, the guest-conversation transcript (ADR 0038,
  [[guest-conversation-transcript]]). The queued June ideas (couple-register oracle, reply on transcript,
  price-book unification) are superseded by the roadmap; triage may resurrect them as issues if they serve
  a milestone.

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
