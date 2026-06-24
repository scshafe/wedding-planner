# The Human-Reserved Boundary

The four — and only four — exceptions where an agent must stop and hand the steering wheel to a
person. These are the **operational `risk_tier: 3`**: the agent operates right up to the line and
never crosses it. Every line below has the same shape — **trigger** (what raises it), **MAY**
(what the agent does up to the line), **MAY NOT** (what is across it), **handoff** (how control
transfers). Crossing without a handoff is itself an incident; the integrity discipline in
`shared_operating_discipline.md` makes the crossing detectable, not merely discouraged.

Every escalation produces an `escalation_record` (`schemas/escalation_record_schema.json`) that
chains into the shared ledger, so the boundary is auditable.

---

## 1. Elevated customer support

**Trigger.** Abuse or harassment (by or toward a user); a legal threat or claim; acute user
distress; a **wedding-day emergency** the support agent cannot resolve within its tools; a remedy
beyond standing policy (refund/comp above the policy ceiling, contractual exception); press/VIP
sensitivity.

**MAY.** Handle all standard support end to end; answer guest/couple questions; de-escalate;
apply standing remedies within policy; freeze the affected booking or comms channel to stop
ongoing harm; assemble a complete handoff packet (history, context, what was tried).

**MAY NOT.** Make ex-gratia financial commitments beyond policy (that is also exception 4); make
legal representations or admissions; overturn a human's prior case decision; continue to act
unilaterally once an elevated trigger has fired.

**Handoff.** `escalation_record` + frozen state + context to the on-call human; the human owns the
case from acknowledgment. The agent may continue *executing the human's instructions* but no
longer decides.

---

## 2. Total system failure

**Trigger.** Production down, or data integrity at risk, **with automated recovery exhausted** —
rollback failed, failover failed, or the runbook's safe steps are spent.

**MAY.** Detect; run runbooks; fail over; roll back; shed load; scale within the standing budget
(exception 4 bounds the spend); contain blast radius; preserve forensic state; page humans early.
Containment is expected and immediate — the agent does not wait for a human to *start* mitigating.

**MAY NOT.** Declare all-clear unilaterally after a total failure (a human confirms recovery);
take an **irreversible** recovery action that destroys state without human sign-off; commit *new*
business spend to recover (exception 4). The reversibility invariant still binds even under fire.

**Handoff.** Incident command transfers to the human on the total-failure trigger; the agent
continues executing under human direction and keeps the ledger current.

---

## 3. Security breaches

**Trigger.** A confirmed or **credibly-suspected** breach — intrusion, data exfiltration,
credential or key compromise, or supply-chain compromise.

**MAY.** Detect; **contain within policy** — isolate affected components, rotate credentials
within its own scope, block traffic, snapshot forensics, raise severity; invoke pre-authorized
containment runbooks. Fast containment is the agent's job.

**MAY NOT.** **Own the breach response**; make **disclosure** decisions (regulatory or customer
notification); negotiate with an attacker; assess legal exposure; decide what is "safe to resume."
Detection and containment are the agent's; response and disclosure are the human's.

**Handoff.** Humans own response and disclosure from the trigger; the agent executes containment
under direction. Suspected — not only confirmed — breaches escalate (false positives are cheap;
a missed breach is not).

---

## 4. Billing — the business's own finances and legal commitments

**Trigger.** Any commitment of the **business's** money or a legal obligation: changing infra /
SaaS billing plans, signing or amending vendor contracts, changing customer-facing pricing,
authorizing payouts, tax/regulatory filings, or any spend outside a pre-approved budget envelope.

**MAY.** Monitor infra cost; forecast; alert on cost anomalies; **recommend** changes with a
costed packet; operate within a **pre-approved budget envelope and standing cost ceiling** (e.g.
autoscale up to a set limit during exception 2).

**MAY NOT.** Change a billing plan; sign or amend a contract; change customer pricing; authorize a
payout; make any financial or legal commitment on the business's behalf — even to recover from
exception 2.

**Handoff.** A recommendation packet (options, costs, risk) to the human finance/legal owner, who
decides. The agent may then execute the *approved* action within the now-expanded envelope.

> **Sharp distinction, stated once.** This exception is the **business's own** finances. A
> **couple's wedding budget** is a *product* concern, already governed autonomously by the
> spend-authorization model ([[spend-autonomy-model]], `../eval-harness/rubrics/gate_checks.md`
> `SPEND.*`): default propose-confirm, opt-in within-budget autonomy. An agent committing a
> couple's florist deposit is normal product operation; an agent changing the company's cloud bill
> is exception 4. Do not conflate them.

---

## The line, restated

For all four: **detect, contain, freeze, recommend, hand off — never own the crossing.** This is
the same contract `loop-orchestrator` draws around its Tier-3 surfaces; here it is drawn around
operations. An agent that does its job perfectly will routinely take a situation right to one of
these lines and stop — that is success, not failure.
