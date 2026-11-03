export interface NavItem {
  readonly id: SectionId;
  readonly label: string;
  readonly issue: string;
  readonly summary: string;
}

export type SectionId = 'missions' | 'decisions' | 'authority' | 'evidence';

/**
 * Primary navigation. Every item maps to a real planned capability with its
 * tracking issue; selecting one shows an honest "not implemented in MTV-01"
 * section — no dead-looking controls and no mocked data behind them.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: 'missions',
    label: 'Mission Treasury',
    issue: '#12',
    summary: 'Mission budgets, reserves and financial operations overview.',
  },
  {
    id: 'decisions',
    label: 'Decision Room',
    issue: '#13',
    summary: 'Agent-proposed plans compared with feasible alternatives and approvals.',
  },
  {
    id: 'authority',
    label: 'Authority & Execution',
    issue: '#7',
    summary: 'Mandates, exact-term approvals and governed provider execution.',
  },
  {
    id: 'evidence',
    label: 'Evidence Replay',
    issue: '#13',
    summary: 'Append-only case timeline linking events, receipts and outcomes.',
  },
];
