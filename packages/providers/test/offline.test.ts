import { describe, expect, it } from 'vitest';
import { offlineCapabilities, offlineProviderStatus } from '../src/index.js';

describe('offline provider descriptors (honest status contract)', () => {
  it('declares every provider OFFLINE with all capabilities disabled', () => {
    for (const id of ['airwallex', 'metal'] as const) {
      const caps = offlineCapabilities(id);
      expect(caps.environment).toBe('offline');
      expect(caps.canReadBalance).toBe(false);
      expect(caps.canTransfer).toBe(false);
      expect(caps.idempotency).not.toBe('none');
    }
  });

  it('never claims connected — labels and wording are explicitly OFFLINE', () => {
    for (const id of ['airwallex', 'metal'] as const) {
      const status = offlineProviderStatus(id);
      expect(status.label).toBe('OFFLINE');
      expect(status.environment).toBe('offline');
      expect(status.detail.toLowerCase()).not.toContain('connected');
    }
  });

  it('points each provider at its tracking issue', () => {
    expect(offlineProviderStatus('airwallex').detail).toContain('#5');
    expect(offlineProviderStatus('metal').detail).toContain('#6');
  });
});
