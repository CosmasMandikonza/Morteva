/**
 * MTV-08 design lab — deterministic synthetic scenario.
 *
 * EVERYTHING HERE IS SYNTHETIC. No provider call is made or implied by this
 * module; amounts are invented fixtures for visual comparison of the two
 * unapproved design directions. Money follows the repo convention
 * (docs/01): integer minor units + explicit ISO currency, formatted at the
 * boundary via lab/format.ts.
 */

export type MoneyMinor = { amount: number; currency: 'USD' | 'EUR' | 'NOK' };

export type LifecycleState =
  | 'PROPOSED'
  | 'RESERVED'
  | 'APPROVED'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'STATUS_UNKNOWN'
  | 'SETTLED'
  | 'RECONCILED'
  | 'REJECTED'
  | 'EXPIRED';

export type EnvLabel = 'SANDBOX' | 'TESTNET' | 'SIMULATED' | 'OFFLINE';

export interface Mission {
  id: string;
  name: string;
  field: string;
  status: 'LIVE' | 'PENDING_EVIDENCE' | 'PLANNED';
  budget: MoneyMinor;
  committed: MoneyMinor;
  currencyNote: string;
  nextAction: string;
  asset: string;
}

export interface CandidatePlan {
  id: string;
  title: string;
  kind: 'no_payment' | 'diagnostic' | 'commitment' | 'rejected';
  cost: MoneyMinor;
  beneficiary?: string;
  rail?: 'airwallex' | 'metal';
  timeToDecide: string;
  assumption: string;
  uncertainty: 'low' | 'medium' | 'high';
  policy: 'WITHIN_AUTHORITY' | 'NEEDS_APPROVAL' | 'REJECTED_BY_POLICY' | 'AUTO_AUTHORIZED';
  policyReason: string;
  economics: string;
}

export interface ReplayEvent {
  id: string;
  t: string; // mission-clock label (synthetic)
  kind:
    | 'observation'
    | 'plan'
    | 'policy'
    | 'approval'
    | 'reservation'
    | 'provider'
    | 'diagnostic'
    | 'delivery'
    | 'outcome';
  title: string;
  detail: string;
  status?: LifecycleState | 'INFO';
  env?: EnvLabel;
}

/** Liquidity snapshot — synthetic Airwallex-sandbox-style account state. */
export const treasury = {
  org: 'Northwind Offshore Inspection AS',
  orgNote: 'Synthetic organization — design fixture',
  asOf: '14:32:07 UTC',
  asOfAge: 'just now',
  accounts: [
    {
      currency: 'USD' as const,
      provider: 'Airwallex',
      env: 'SANDBOX' as EnvLabel,
      balance: usd(184_250_00),
      reserved: usd(28_600_00),
      pending: usd(6_400_00),
      protectedReserve: usd(50_000_00),
      history: [61, 62, 60, 64, 63, 67, 66, 71, 69, 74, 73, 78, 76, 81].map((v, i) => ({
        day: `D${i + 1}`,
        committedPctK: v,
      })),
    },
    {
      currency: 'EUR' as const,
      provider: 'Airwallex',
      env: 'SANDBOX' as EnvLabel,
      balance: eur(42_100_00),
      reserved: eur(8_900_00),
      pending: eur(0),
      protectedReserve: eur(10_000_00),
      history: [40, 41, 43, 42, 44, 46, 45, 47, 49, 48, 50, 52, 51, 53].map((v, i) => ({
        day: `D${i + 1}`,
        committedPctK: v,
      })),
    },
  ],
};

export function usd(amount: number): MoneyMinor {
  return { amount, currency: 'USD' };
}
export function eur(amount: number): MoneyMinor {
  return { amount, currency: 'EUR' };
}

export function spendable(a: {
  balance: MoneyMinor;
  reserved: MoneyMinor;
  pending: MoneyMinor;
  protectedReserve: MoneyMinor;
}): MoneyMinor {
  return {
    amount: a.balance.amount - a.reserved.amount - a.pending.amount - a.protectedReserve.amount,
    currency: a.balance.currency,
  };
}

export const missions: Mission[] = [
  {
    id: 'M-104',
    name: 'Turbine T-12 blade inspection',
    field: 'Havsul field · North Sea',
    status: 'LIVE',
    budget: usd(12_000_00),
    committed: usd(4_250_00),
    currencyNote: 'USD',
    nextAction: 'Review 4 candidate plans',
    asset: 'Inspection UAV · callsign SEAGULL-2',
  },
  {
    id: 'M-098',
    name: 'Subsea mooring survey',
    field: 'Nordsjø B · mooring lines 4–8',
    status: 'PENDING_EVIDENCE',
    budget: eur(15_000_00),
    committed: eur(8_900_00),
    currencyNote: 'EUR',
    nextAction: 'Survey evidence stale (47 min) — refresh required',
    asset: 'Work-class ROV · callsign DEEPLINE-1',
  },
  {
    id: 'M-112',
    name: 'Met-mast anemometer swap',
    field: 'Havsul field · met mast',
    status: 'PLANNED',
    budget: usd(3_200_00),
    committed: usd(0),
    currencyNote: 'USD',
    nextAction: 'Awaiting weather window ( Tue )',
    asset: 'Surface vessel · callsign VESTFJORD',
  },
];

export const exceptions = [
  {
    id: 'EX-01',
    severity: 'high' as const,
    kind: 'STATUS_UNKNOWN',
    title: 'Transfer TRX-8812 — response lost after submit',
    detail:
      'Original request id retained; commitment held. Verify by original ID — never resubmit blind.',
    env: 'SANDBOX' as EnvLabel,
  },
  {
    id: 'EX-02',
    severity: 'medium' as const,
    kind: 'STALE_EVIDENCE',
    title: 'M-098 survey evidence aged out (47 min > 30 min policy)',
    detail: 'Autonomous commitments suspended for M-098 until fresh observation.',
    env: 'SIMULATED' as EnvLabel,
  },
  {
    id: 'EX-03',
    severity: 'medium' as const,
    kind: 'MANDATE_EXPIRY',
    title: 'Mission M-104 mandate expires in 26 h',
    detail: 'After expiry, spending authority lapses; re-authorization required.',
    env: 'SANDBOX' as EnvLabel,
  },
];

/** The decision case both candidates must render identically. */
export const decisionCase = {
  mission: missions[0]!,
  event: {
    id: 'EV-2214',
    title: 'Suspected leading-edge crack · blade B · 38 m span',
    observedAt: '14:28 UTC (4 min ago)',
    provenance: 'SIMULATED_OBSERVATION',
    freshness: 'fresh' as const,
    source: 'UAV optical payload · 240 frames · on-board geotag',
    confidence: 'medium — single pass, 62 % frame agreement',
  },
  constraintSet: [
    { clause: 'Budget envelope (remaining)', value: 'USD 7,750.00' },
    { clause: 'Per-action limit', value: 'USD 500.00 (above needs approval)' },
    { clause: 'Protected reserve floor', value: 'USD 50,000.00 — untouchable' },
    { clause: 'Approved counterparties', value: 'NorthSea Divers AS · MareData GmbH' },
    { clause: 'Mandate expiry', value: '26 h 04 m' },
  ],
  plans: [
    {
      id: 'P0',
      title: 'Hold · second inspection pass tomorrow',
      kind: 'no_payment' as const,
      cost: usd(0),
      timeToDecide: 'T+22 h',
      assumption: 'Crack, if real, is stable for 24 h (class-I defect growth model)',
      uncertainty: 'high' as const,
      policy: 'WITHIN_AUTHORITY' as const,
      policyReason: 'No spend — agent may proceed autonomously',
      economics: 'Risk: repair window slips one tide cycle; exposure +USD 1,400 est.',
    },
    {
      id: 'P1',
      title: 'Buy damage-grade AI diagnostic (data feed)',
      kind: 'diagnostic' as const,
      cost: usd(180_00),
      beneficiary: 'MareData GmbH',
      rail: 'metal' as const,
      timeToDecide: 'T+40 min',
      assumption: 'Diagnostic refines crack class from ±2 to ±0.5 grades',
      uncertainty: 'medium' as const,
      policy: 'AUTO_AUTHORIZED' as const,
      policyReason: 'USD 180.00 ≤ USD 500.00 per-action limit · mandated vendor',
      economics: 'Expected value +USD 3,100 (avoids ~15 % chance of wrong-call repair)',
    },
    {
      id: 'P2',
      title: 'Retainer repair crew · standby at field',
      kind: 'commitment' as const,
      cost: usd(2_150_00),
      beneficiary: 'NorthSea Divers AS',
      rail: 'airwallex' as const,
      timeToDecide: 'T+2 h',
      assumption: 'Crew mobilizes within 6 h of standby confirmation',
      uncertainty: 'low' as const,
      policy: 'NEEDS_APPROVAL' as const,
      policyReason: 'USD 2,150.00 > USD 500.00 per-action limit — human approval required',
      economics: 'Saves ~18 h vs. cold mobilization if confirmed; forfeits retainer if cancelled',
    },
    {
      id: 'P3',
      title: 'Replace blade immediately',
      kind: 'rejected' as const,
      cost: usd(48_000_00),
      beneficiary: 'NorthSea Divers AS',
      rail: 'airwallex' as const,
      timeToDecide: '—',
      assumption: 'Crack confirmed class-IV (not yet established)',
      uncertainty: 'high' as const,
      policy: 'REJECTED_BY_POLICY' as const,
      policyReason: 'USD 48,000.00 exceeds USD 7,750.00 envelope — blocked before spend',
      economics: 'Not evaluated — infeasible under active mandate',
    },
  ] satisfies CandidatePlan[],
};

/** Authority & Execution preview — the exact immutable terms of P2. */
export const approvalRequest = {
  planRef: 'P2 · Retainer repair crew',
  digest: '0x9f3a…c41d',
  terms: [
    { label: 'Beneficiary', value: 'NorthSea Divers AS', locked: true },
    { label: 'Amount', value: 'USD 2,150.00', locked: true },
    { label: 'Currency', value: 'USD', locked: true },
    { label: 'Purpose', value: 'Standby retainer · turbine T-12 blade B', locked: true },
    { label: 'Quote ref', value: 'Q-2291 (valid 26 h)', locked: true },
    { label: 'Rail', value: 'Airwallex · Sandbox', locked: true },
    { label: 'Evidence digest', value: 'EV-2214 @ 14:28 UTC', locked: true },
    { label: 'Expiry', value: '26 h 04 m', locked: true },
  ],
  policyChecks: [
    {
      clause: 'Envelope remaining',
      verdict: 'pass' as const,
      detail: 'USD 2,150.00 ≤ USD 7,750.00',
    },
    {
      clause: 'Per-action limit',
      verdict: 'approval' as const,
      detail: 'above USD 500.00 — this approval',
    },
    {
      clause: 'Protected reserve',
      verdict: 'pass' as const,
      detail: 'spendable USD 99,250.00 after commit',
    },
    {
      clause: 'Counterparty list',
      verdict: 'pass' as const,
      detail: 'NorthSea Divers AS is mandated',
    },
    { clause: 'Evidence freshness', verdict: 'pass' as const, detail: '4 min old (limit 30 min)' },
    {
      clause: 'Mandate version',
      verdict: 'pass' as const,
      detail: 'v3 · unchanged since approval digest',
    },
  ],
  operation: {
    id: 'OP-3127',
    requestId: 'req_2xK91mQz',
    providerId: '— (not yet submitted)',
  },
};

export const replayEvents: ReplayEvent[] = [
  {
    id: 'RE-01',
    t: '13:58',
    kind: 'observation',
    title: 'Mission M-104 window opened · UAV SEAGULL-2 on station',
    detail: 'Geofence + telemetry nominal. Provenance: SIMULATED_OBSERVATION.',
    status: 'INFO',
  },
  {
    id: 'RE-02',
    t: '14:28',
    kind: 'observation',
    title: 'EV-2214 · suspected crack, blade B @ 38 m',
    detail: 'Optical payload, 240 frames, on-board geotag. Freshness 4 min.',
    status: 'INFO',
    env: 'SIMULATED',
  },
  {
    id: 'RE-03',
    t: '14:29',
    kind: 'plan',
    title: 'Planner compared 4 candidate plans (incl. hold)',
    detail:
      'P0 hold · P1 diagnostic USD 180.00 · P2 retainer USD 2,150.00 · P3 blocked by envelope.',
    status: 'PROPOSED',
  },
  {
    id: 'RE-04',
    t: '14:30',
    kind: 'policy',
    title: 'P3 rejected by policy before any spend',
    detail: 'USD 48,000.00 exceeds envelope. No reservation created.',
    status: 'REJECTED',
  },
  {
    id: 'RE-05',
    t: '14:30',
    kind: 'reservation',
    title: 'Reservation taken · USD 2,150.00 (M-104 / USD pool)',
    detail: 'Internal commitment — NOT a provider escrow. Competing mission M-098 denied cleanly.',
    status: 'RESERVED',
  },
  {
    id: 'RE-06',
    t: '14:31',
    kind: 'diagnostic',
    title: 'P1 diagnostic purchased on Metal testnet',
    detail: 'USD 180.00 · order 0x7b2f…e0 · hash verifiable. Data delivery: pending.',
    status: 'SUBMITTED',
    env: 'TESTNET',
  },
  {
    id: 'RE-07',
    t: '14:31',
    kind: 'approval',
    title: 'Human approval · exact terms digest 0x9f3a…c41d',
    detail: 'Beneficiary/amount/currency/purpose bound. Changed terms would invalidate.',
    status: 'APPROVED',
  },
  {
    id: 'RE-08',
    t: '14:32',
    kind: 'provider',
    title: 'Airwallex transfer submitted · req_2xK91mQz',
    detail: 'SUBMITTED is not SETTLED. Status read back independently; amber until confirmed.',
    status: 'SUBMITTED',
    env: 'SANDBOX',
  },
  {
    id: 'RE-09',
    t: '14:36',
    kind: 'provider',
    title: 'Provider-verified settlement · TRX-8813',
    detail:
      'Confirmed by independent read-back. Receipt available. Fee USD 4.30 reconciled in-currency.',
    status: 'SETTLED',
    env: 'SANDBOX',
  },
  {
    id: 'RE-10',
    t: '15:04',
    kind: 'delivery',
    title: 'MareData diagnostic delivered · provenance recorded',
    detail: 'Purchased data is evidence, not truth: crack class C+ confirmed on 2nd pass.',
    status: 'RECONCILED',
    env: 'TESTNET',
  },
  {
    id: 'RE-11',
    t: '16:40',
    kind: 'outcome',
    title: 'Operating outcome · crew on standby, repair window booked',
    detail: 'Operating status tracked separately from financial status. Mission continues.',
    status: 'INFO',
    env: 'SIMULATED',
  },
];

/** Org-wide committed trend, 14 synthetic days (USD thousands). */
export const commitmentHistory = [
  { day: 'D1', usdK: 61 },
  { day: 'D2', usdK: 62 },
  { day: 'D3', usdK: 60 },
  { day: 'D4', usdK: 64 },
  { day: 'D5', usdK: 63 },
  { day: 'D6', usdK: 67 },
  { day: 'D7', usdK: 66 },
  { day: 'D8', usdK: 71 },
  { day: 'D9', usdK: 69 },
  { day: 'D10', usdK: 74 },
  { day: 'D11', usdK: 73 },
  { day: 'D12', usdK: 78 },
  { day: 'D13', usdK: 76 },
  { day: 'D14', usdK: 81 },
];

/** Mission M-104 committed trend, 14 days (USD thousands) against its USD 12k envelope. */
export const missionCommitmentHistory = [
  0.4, 0.9, 1.6, 2.1, 2.6, 2.9, 3.1, 3.3, 3.5, 3.7, 3.85, 3.95, 4.1, 4.25,
];

export const labNotice =
  'DESIGN LAB · SYNTHETIC DATA — every figure on this page is an invented fixture. No provider is called; no transaction is real. Production 3D (MTV-09) replaces the staging viewport.';
