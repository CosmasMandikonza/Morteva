/**
 * FileReceiptStore — durable JSONL receipt journal for the gated smoke
 * harness (issue #6). The LEDGER remains the production receipt store
 * (Agent A's provider-aware migration is the contract); this store gives the
 * standalone smoke the same durable-identity guarantees across runs so a
 * rerun always reconciles the ORIGINAL signed transaction instead of ever
 * re-signing. Append-only by construction (lines are never rewritten); a
 * torn final line (crash mid-append) is skipped on read, never guessed.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MetalReceiptStore } from './dispatcher.js';

interface StoredLine {
  orgId: string;
  operationId: string | null;
  requestId: string;
  providerResourceId: string | null;
  kind: string;
  environment: string;
  httpStatus: number | null;
  providerStatus: string | null;
  payloadJson: string;
  recordedAt: string;
}

export class FileReceiptStore implements MetalReceiptStore {
  private readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, 'receipts.jsonl');
  }

  append(receipt: Parameters<MetalReceiptStore['append']>[0]): void {
    const line = JSON.stringify({
      orgId: receipt.orgId,
      operationId: receipt.operationId,
      requestId: receipt.requestId,
      providerResourceId: receipt.providerResourceId,
      kind: receipt.kind,
      environment: receipt.environment,
      httpStatus: receipt.httpStatus,
      providerStatus: receipt.providerStatus,
      payloadJson: receipt.payloadJson,
      recordedAt: receipt.recordedAt,
    } satisfies StoredLine);
    appendFileSync(this.path, `${line}\n`, 'utf8');
  }

  listByRequestId(requestId: string, orgId: string): StoredLine[] {
    if (!existsSync(this.path)) return [];
    const out: StoredLine[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as StoredLine;
        if (parsed.requestId === requestId && parsed.orgId === orgId) out.push(parsed);
      } catch {
        // Torn line: skipped, never guessed.
      }
    }
    return out;
  }
}
