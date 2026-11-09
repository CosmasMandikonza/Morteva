/**
 * ProviderReceiptService — append-only storage for Airwallex (and later
 * Metal) interaction receipts over migration 0003's provider_receipts table.
 * Implements the adapter package's AirwallexReceiptStore contract so the
 * dispatcher persists evidence inside the ledger database, org-scoped.
 *
 * Payloads arrive pre-redacted from the adapter; this service additionally
 * refuses to persist anything credential-shaped as a second line of defense.
 */
import { randomUUID } from 'node:crypto';
import type { LedgerDatabase } from '../db/port.js';
import { num, text } from '../db/port.js';
import { LedgerError } from '../errors.js';
import type { Clock } from '../clock.js';
import type {
  ProviderReceipt,
  ProviderReceiptEnvironment,
  ProviderReceiptProvider,
  ProviderReceiptKind,
  ProviderReceiptStore,
} from '@moterva/providers';

const SECRET_SHAPE =
  /"(?:api[_-]?key|token|authorization|password|secret)"\s*:\s*"(?!\[REDACTED\])[A-Za-z0-9_-]{8,}"/i;

export class ProviderReceiptService implements ProviderReceiptStore {
  constructor(
    private readonly db: LedgerDatabase,
    private readonly clock: Clock,
  ) {}

  append(receipt: ProviderReceipt): void {
    if (SECRET_SHAPE.test(receipt.payloadJson)) {
      throw new LedgerError(
        'INVALID_INPUT',
        'provider receipt payload appears to contain credential material; refusing to persist',
      );
    }
    try {
      this.db
        .prepare(
          `INSERT INTO provider_receipts
             (id, org_id, operation_id, request_id, provider, transfer_id, kind, environment, http_status, provider_status, payload_json, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `rcpt_${randomUUID()}`,
          receipt.orgId,
          receipt.operationId,
          receipt.requestId,
          receipt.provider satisfies ProviderReceiptProvider,
          receipt.providerResourceId,
          receipt.kind satisfies ProviderReceiptKind,
          receipt.environment,
          receipt.httpStatus,
          receipt.providerStatus,
          receipt.payloadJson,
          receipt.recordedAt !== '' ? receipt.recordedAt : this.clock.iso(),
        );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/append-only/i.test(message)) {
        throw new LedgerError(
          'JOURNAL_APPEND_ONLY',
          `provider receipts rejected a mutation: ${message}`,
        );
      }
      throw error;
    }
  }

  listByRequestId(requestId: string, orgId: string): readonly ProviderReceipt[] {
    const rows = this.db
      .prepare(
        `SELECT id, org_id, operation_id, request_id, provider, transfer_id, kind, environment, http_status, provider_status, payload_json, recorded_at
         FROM provider_receipts WHERE request_id = ? AND org_id = ? ORDER BY seq`,
      )
      .all(requestId, orgId);
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        provider: text(r.provider, 'provider') as ProviderReceiptProvider,
        orgId: text(r.org_id, 'org_id'),
        operationId: r.operation_id === null ? null : text(r.operation_id, 'operation_id'),
        requestId: text(r.request_id, 'request_id'),
        providerResourceId: r.transfer_id === null ? null : text(r.transfer_id, 'transfer_id'),
        kind: text(r.kind, 'kind') as ProviderReceiptKind,
        environment: text(r.environment, 'environment') as ProviderReceiptEnvironment,
        httpStatus: r.http_status === null ? null : num(r.http_status, 'http_status'),
        providerStatus:
          r.provider_status === null ? null : text(r.provider_status, 'provider_status'),
        payloadJson: text(r.payload_json, 'payload_json'),
        recordedAt: text(r.recorded_at, 'recorded_at'),
      } satisfies ProviderReceipt;
    });
  }

  countByOperation(operationId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM provider_receipts WHERE operation_id = ?')
      .get(operationId) as { c: number };
    return num(row.c, 'count');
  }
}
