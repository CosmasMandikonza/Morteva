/**
 * Namespaced provider request identities (R3 review P0-2).
 *
 * The ledger's request-ID uniqueness is ORGANIZATION-scoped, so two orgs can
 * legitimately use the same local request id. Airwallex's request_id
 * dedupe/recovery namespace is GLOBAL per account, but reconciliation by
 * request id must never be ambiguous across tenants. The adapter therefore
 * derives the provider-visible request id deterministically from
 * (orgId, ledgerRequestId) with an org hash prefix: same org → same provider
 * id (safe retry of the SAME economic intent); different orgs → different
 * provider ids (no cross-tenant collision possible, on our side or the
 * provider's).
 *
 * Airwallex documents request_id as 10–50 characters (builder guide); we
 * enforce that BEFORE any provider call and fail closed on violation.
 */
import { createHash } from 'node:crypto';

const PROVIDER_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MIN_PROVIDER_REQUEST_ID_LENGTH = 10;
export const MAX_PROVIDER_REQUEST_ID_LENGTH = 50;

function orgTag(orgId: string): string {
  return createHash('sha256').update(orgId, 'utf8').digest('hex').slice(0, 10);
}

export function providerRequestIdFor(orgId: string, ledgerRequestId: string): string {
  if (orgId.trim() === '') {
    throw new Error('providerRequestIdFor requires a non-empty organization id');
  }
  const local = ledgerRequestId.trim();
  if (local === '') {
    throw new Error('providerRequestIdFor requires a non-empty ledger request id');
  }
  if (!PROVIDER_REQUEST_ID_PATTERN.test(local)) {
    throw new Error(
      `ledger request id "${ledgerRequestId}" contains characters Airwallex request ids do not allow (allowed: A-Z a-z 0-9 . _ -, leading alphanumeric); refusing to dispatch`,
    );
  }
  const providerId = `mtv-${orgTag(orgId)}-${local}`;
  if (providerId.length > MAX_PROVIDER_REQUEST_ID_LENGTH) {
    throw new Error(
      `namespaced provider request id would be ${String(providerId.length)} characters (max ${String(MAX_PROVIDER_REQUEST_ID_LENGTH)}; "mtv-" + 10-char org tag + local id). Shorten the ledger request id.`,
    );
  }
  return providerId;
}

/** True when two organizations map to distinct provider request ids for identical local ids. */
export function distinctAcrossOrgs(orgA: string, orgB: string, ledgerRequestId: string): boolean {
  return (
    providerRequestIdFor(orgA, ledgerRequestId) !== providerRequestIdFor(orgB, ledgerRequestId)
  );
}
