import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  describeOutcome,
  provenanceCopy,
  rejectionCopy,
  REJECTION_COPY,
} from '../src/lib/decisionCopy';

describe('operator language for planner outcomes (no softened refusals)', () => {
  it('every planner rejection code has plain-language copy (drift guard)', () => {
    const src = readFileSync(
      new URL('../../../packages/planner/src/contracts.ts', import.meta.url),
      'utf8',
    );
    const union = /export type CandidateRejectionCode =([\s\S]*?);/.exec(src)?.[1] ?? '';
    const codes = [...union.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1] as string);
    expect(codes.length).toBeGreaterThan(10);
    for (const code of codes) {
      expect(REJECTION_COPY[code], `missing copy for ${code}`).toBeTruthy();
    }
  });

  it('an unknown code is still refused in words — never shown as eligible', () => {
    expect(rejectionCopy('SOME_FUTURE_CODE')).toContain('Refused');
    expect(rejectionCopy('none')).toContain('Eligible');
    expect(rejectionCopy(null)).toContain('Eligible');
  });

  it('classifies the four outcomes an operator must tell apart', () => {
    expect(describeOutcome('select', { grossMinor: 0 }).kind).toBe('no-action');
    expect(describeOutcome('select', null).kind).toBe('no-action');
    expect(describeOutcome('select', { grossMinor: 715_000 }).kind).toBe('spend');
    expect(describeOutcome('decline', null).kind).toBe('decline');
    expect(describeOutcome('escalate', null).kind).toBe('escalate');
    // a spend is never described as approved
    expect(describeOutcome('select', { grossMinor: 5 }).label).toContain('AWAITING HUMAN APPROVAL');
  });

  it('FIELD is a source-authenticated CLAIM, never independently measured truth', () => {
    const field = provenanceCopy('FIELD');
    expect(field.badge).toContain('CLAIM');
    expect(field.detail).toMatch(/not that the sensor is correct/);
    expect(provenanceCopy('SYNTHETIC').badge).toContain('NOT A FIELD MEASUREMENT');
  });
});
