/**
 * Mission-event contract identity.
 *
 * The wire envelope and the normalized event both carry `contractVersion`.
 * Bumping it is a breaking change that requires a new schema document under
 * contract/ and coordination on issues #8/#9 — older versions are refused,
 * never silently coerced.
 */
export const MISSION_EVENT_CONTRACT_VERSION = 1 as const;

/**
 * Version of the ingest validator itself (rejection rules, ordering checks,
 * freshness policy). Journaled with every accepted event so replay can prove
 * which rules admitted it.
 */
export const INGEST_VALIDATOR_VERSION = 1 as const;
