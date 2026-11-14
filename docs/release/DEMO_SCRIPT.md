# MOTERVA demo script — under five minutes, from the real product (issue #19)

Built only from what the acceptance matrix proves at the release SHA. Every
step names what is REAL, what is SYNTHETIC, and what is DISABLED — those
labels are part of the product, not disclaimers bolted on for judges.

## The twenty-second explanation (say this first)

> When something changes in the physical world, MOTERVA determines what that
> means for the mission's money, proposes an authorized response, gets a
> separate human approval, executes with the payment provider, and preserves
> replayable evidence of every decision.

One sentence of category: **a mission-scoped financial operating system for
physical operations** — governance layer between field telemetry and company
money.

## Setup (pre-demo, 30s)

`node scripts/release/demo.mjs` at the release SHA → http://localhost:4173,
sign in `founder / moterva-e2e-demo`. Screens: Treasury → Decision Room →
Evidence. Backup: recorded replay file (clearly watermarked "RECORDED
REPLAY") in case the live machine fails; the fallback runs offline with
providers off — identical labeling.

## The five-minute structure

### 1. The mission and its financial authority (~45s)
- Treasury: "Harbor turbine inspection". Show the mission hero: effective
  authority **USD 76,500.00 / EUR 37,000.00**.
- Point at the GBP mandate: **lapsed by clock — not spendable, recorded
  status 'active'**. "The system distinguishes what the ledger recorded from
  what is actually usable, and never spends authority the clock killed."
- Provenance chip: **"DEMO_AUTH · seeded internal ledger — not Airwallex
  funds."** — say it out loud; it is the trust posture in one line.

### 2. The physical inspection and the incident (~45s)
- Decision Room: SYNTHETIC-labeled operational timeline for `uav-seeker-1`.
- Admit the incident: wind reading **24.6 kt over the 22 kt limit**.
- "This is synthetic evidence, signed and journaled like real sensor input
  would be — MOTERVA never treats the physical world as verified fact, but
  it does treat it as first-class financial input."

### 3. The financial consequence and the decision (~60s) — THE decisive moment
- The planner's REAL evaluation flips: incumbent UAV option becomes
  `ASSET_SAFETY_BLOCKED`; the comparison shows the vessel alternative
  (USD 18,500.00 incl. fee, longer lead time, lower success probability).
- "One physical reading changed the economic ranking of two real spend
  options — computed by typed policy code, not a language model guessing."
- Show financial position: **spendable USD 164,000.00 = 250,000 − 500 floor
  − 72,000 reserved − 13,500 unknown** — the exact arithmetic on screen.

### 4. Independent human approval (~40s)
- Sign out → sign in as `approver` (separation of duties is enforced by the
  engine: the proposer cannot approve).
- The immutable plan terms: exact amount, beneficiary, purpose, quote digest.
- Approve → "No approval, no money. Changed terms structurally invalidate
  the approval — the digest binds them."

### 5. Verified provider result — where available (~30s)
- System status: **Airwallex rail OFFLINE — DISABLED until sandbox
  credentials (issue #5). No provider call is claimed.**
- The operation ladder on screen: SUBMITTED ≠ SETTLED; STATUS_UNKNOWN
  **retains** the commitment ("resolve by the original request ID");
  REQUIRES_HUMAN holds exposure.
- "When credentials land, the same journey executes on Airwallex sandbox and
  settles only on independent readback — the adapter is merged and
  adversarially tested, disabled honestly."

### 6. Evidence Replay (~40s)
- Evidence screen: the same operation id filters the append-only journal —
  physical observation, decision, approval, reservation, lifecycle — in
  causal order with digests.
- Refresh the page: same IDs, same order. "The causal chain from a wind
  reading to a governed payment survives restart; that is the audit product."

### 7. Commercial takeaway (~20s)
- For an operator running dozens of inspection missions with external
  service providers, the handoffs between "what happened in the field" and
  "what we're allowed to pay" are spreadsheets, phone calls and after-the-
  fact reconciliation. MOTERVA is the governed bridge — with receipts.
- Point to the competitive memo (issue #18 PR) for the sourced matrix.

## Truth requirements enforced during the demo (checklist)

- [ ] SYNTHETIC labels visible whenever physical evidence is shown.
- [ ] "Not Airwallex funds" / provider OFFLINE stated in words.
- [ ] Submitted ≠ settled; UNKNOWN retains — never glossed as failure or success.
- [ ] Buyer economics framed as hypothesis with assumptions (memo).
- [ ] Backup replay watermarked RECORDED REPLAY if used.
- [ ] No claim of real-world savings; benchmark numbers only from the
      reproducible 45-case matrix (baseline ties AND losses included).

## What NOT to claim (same discipline)

- No "first ever / no competitors" — the memo's matrix names coverage.
- No real money, real bank, real vehicles.
- No promise that Metal is imminent (explicitly RAIL_ASSET_UNSUPPORTED).
