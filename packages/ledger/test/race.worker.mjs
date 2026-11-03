/**
 * Race-test worker: opens its OWN connection to the shared SQLite file and
 * attempts one reservation with the given economic inputs. Runs on a real
 * OS thread, so write-lock contention is genuine. The connection is closed
 * on every path before reporting, so the parent never sees leaked handles.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openLedger, isLedgerError } from '@moterva/ledger';

const data = /** @type {any} */ (workerData);

let ledger = null;
try {
  ledger = openLedger(data.dbPath);
  const result = ledger.reservations.reserve({
    orgId: data.orgId,
    missionId: data.missionId,
    kind: data.kind ?? 'airwallex_transfer',
    requestId: data.requestId,
    planId: data.planId,
    planVersion: data.planVersion,
    approvalId: data.approvalId,
  });
  ledger.close();
  ledger = null;
  parentPort.postMessage({
    ok: true,
    operationId: result.operation.id,
    duplicate: result.duplicate,
  });
} catch (error) {
  if (ledger) {
    try {
      ledger.close();
    } catch {
      /* already closed */
    }
  }
  parentPort.postMessage({
    ok: false,
    code: isLedgerError(error) ? error.code : 'UNEXPECTED',
    message: error instanceof Error ? error.message : String(error),
  });
}
