/**
 * TokenAssetService — registered on-chain token assets (MTV-19 / issue #6 boundary).
 *
 * A token asset is the ledger's TRUSTED identity of one on-chain currency:
 * { chain id, contract address, decimals, symbol, environment } scoped per
 * organization, with a dedicated token account (kind 'token'). Registration
 * is the boundary that lets the mandate/reservation machinery authorize
 * `metal_order`: the metadata is treated as verified configuration because
 * the Metal adapter's `discoverToken` reads `decimals()`/`symbol()` on-chain
 * before connecting (Agent D) — the ledger never invents it.
 *
 * Trust boundary: registration is a SERVER-SIDE operation restricted to
 * owner/admin creators (never an HTTP route, never viewer/operator input) —
 * a token asset is verified adapter configuration, not user-supplied data.
 * Balance snapshots are recorded only by trusted server-side code from
 * VERIFIED adapter chain reads (the adapter proves decimals/symbol on-chain
 * at connect; the ledger re-checks chain/contract against the registry).
 *
 * Chain-read freshness (CTO R3 P0-3): a chain read older than
 * CHAIN_READ_MAX_AGE_MS is refused — a stale claimed balance can never back
 * reservations for years; observedAt must not precede chainReadAt (reversed
 * temporal ordering refused); the snapshot expiry is capped at
 * CHAIN_SNAPSHOT_MAX_TTL_MS past the observation, so SpendableService's
 * freshness check can never be satisfied by an old read with future expiry.
 *
 * Token balance snapshots are ordinary `balance_snapshots` rows for the
 * token's currency with source 'metal-testnet' and MANDATORY chain-read
 * provenance (chain_id + contract + chain_read_at), so the existing
 * spendable/reservation math applies unchanged while a fiat snapshot can
 * never masquerade as a chain read (and vice versa).
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { LedgerDatabase } from '../db/port.js';
import { nullableText, text } from '../db/port.js';
import { LedgerError } from '../errors.js';
import type { Clock } from '../clock.js';
import { newId } from './identity.js';
import type { EvidenceService } from './evidence.js';
import { createMoney } from '@moterva/domain';

/**
 * Maximum age of a verified chain read that may back a balance snapshot —
 * a chainReadAt older than this (e.g. a replayed 2020 read) is refused.
 */
export const CHAIN_READ_MAX_AGE_MS = 15 * 60_000;
/**
 * Maximum lifetime of a token balance snapshot past its observation time —
 * a caller-supplied `expiresAt` years in the future (the 2035
 * counterexample) is capped/refused, so SpendableService's freshness check
 * can never be satisfied by an old read with future expiry.
 */
export const CHAIN_SNAPSHOT_MAX_TTL_MS = 30 * 60_000;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface TokenAssetView {
  readonly id: string;
  readonly orgId: string;
  readonly accountId: string;
  /** Ledger currency code for this token (3..8 uppercase, e.g. 'USDZ'). */
  readonly currency: string;
  /** On-chain symbol as verified by the adapter (e.g. 'USDZ'). */
  readonly symbol: string;
  readonly decimals: number;
  readonly contractAddress: string;
  readonly chainId: number;
  readonly environment: 'testnet';
  readonly createdBy: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export class TokenAssetService {
  constructor(
    private readonly db: LedgerDatabase,
    private readonly clock: Clock,
    private readonly evidence: EvidenceService,
  ) {}

  /**
   * Registers a token asset for an organization and opens its token account.
   * Isolation rules enforced here:
   *  - the ledger currency code must be uppercase 3..8 letters and must NOT
   *    equal an existing treasury (fiat) currency of this org;
   *  - one active asset per (org, currency) and per (org, chain, contract).
   */
  registerTokenAsset(input: {
    orgId: string;
    currency: string;
    symbol: string;
    decimals: number;
    contractAddress: string;
    chainId: number;
    environment?: 'testnet';
    createdByActorId: string;
  }): TokenAssetView {
    const currency = input.currency.trim().toUpperCase();
    const symbol = input.symbol.trim();
    if (!/^[A-Z]{3,8}$/.test(currency)) {
      throw new LedgerError(
        'INVALID_INPUT',
        'token currency must be 3-8 uppercase letters (the ledger code, e.g. USDZ)',
      );
    }
    const fiat = this.db
      .prepare("SELECT id FROM accounts WHERE org_id = ? AND kind = 'treasury' AND currency = ?")
      .get(input.orgId, currency);
    if (fiat !== undefined) {
      throw new LedgerError(
        'CURRENCY_COLLISION',
        `currency ${currency} already exists as a fiat treasury account in this organization; a token asset must use its own ledger code`,
      );
    }
    if (symbol.length < 2 || symbol.length > 12) {
      throw new LedgerError('INVALID_INPUT', 'token symbol must be 2-12 characters');
    }
    if (!Number.isSafeInteger(input.decimals) || input.decimals < 0 || input.decimals > 18) {
      throw new LedgerError('INVALID_INPUT', 'token decimals must be an integer 0-18');
    }
    const contract = input.contractAddress.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(contract)) {
      throw new LedgerError(
        'INVALID_INPUT',
        'contract address must be a 0x-prefixed 40-hex address',
      );
    }
    if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
      throw new LedgerError('INVALID_INPUT', 'chain id must be a positive integer');
    }
    if ((input.environment ?? 'testnet') !== 'testnet') {
      throw new LedgerError('INVALID_INPUT', "only the 'testnet' environment is supported");
    }
    const creator = this.db
      .prepare('SELECT id, role FROM actors WHERE id = ? AND org_id = ? AND revoked_at IS NULL')
      .get(input.createdByActorId, input.orgId) as { id: string; role: string } | undefined;
    if (creator === undefined) {
      throw new LedgerError(
        'AUTH_ACTOR_NOT_FOUND',
        'registration actor not found in this organization',
      );
    }
    // Trust boundary (CTO R3 P0-3): only owners/admins may register a token
    // asset — verified adapter configuration, never viewer/operator input.
    if (creator.role !== 'owner' && creator.role !== 'admin') {
      throw new LedgerError(
        'AUTH_ROLE_FORBIDDEN',
        'only owners and admins may register token assets; a token asset is verified adapter configuration, not user-supplied data',
      );
    }
    const active = this.db
      .prepare(
        'SELECT id FROM token_assets WHERE org_id = ? AND currency = ? AND revoked_at IS NULL',
      )
      .get(input.orgId, currency);
    if (active !== undefined) {
      throw new LedgerError(
        'TOKEN_ASSET_DUPLICATE',
        `an active token asset for currency ${currency} already exists in this organization`,
      );
    }
    const sameContract = this.db
      .prepare(
        'SELECT id, currency FROM token_assets WHERE org_id = ? AND chain_id = ? AND contract_address = ? AND revoked_at IS NULL',
      )
      .get(input.orgId, input.chainId, contract) as { id: string; currency: string } | undefined;
    if (sameContract !== undefined) {
      throw new LedgerError(
        'TOKEN_ASSET_DUPLICATE',
        `contract ${contract} on chain ${input.chainId} is already registered as ${sameContract.currency}`,
      );
    }

    // Dedicated token account (kind 'token', floor 0 — a chain read is the
    // only balance source; there is no fiat-style protected floor to defend).
    const existingAccount = this.db
      .prepare("SELECT id FROM accounts WHERE org_id = ? AND currency = ? AND kind = 'token'")
      .get(input.orgId, currency) as { id: string } | undefined;
    const accountId = existingAccount?.id ?? newId('acct');
    if (existingAccount === undefined) {
      this.db
        .prepare(
          'INSERT INTO accounts (id, org_id, currency, kind, label, protected_floor_minor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          accountId,
          input.orgId,
          currency,
          'token',
          `token ${symbol} chain ${input.chainId}`,
          0,
          this.clock.iso(),
        );
    }

    const id = newId('tkn');
    const asset: TokenAssetView = {
      id,
      orgId: input.orgId,
      accountId,
      currency,
      symbol,
      decimals: input.decimals,
      contractAddress: contract,
      chainId: input.chainId,
      environment: 'testnet',
      createdBy: input.createdByActorId,
      createdAt: this.clock.iso(),
      revokedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO token_assets (id, org_id, account_id, currency, symbol, decimals, contract_address, chain_id, environment, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        asset.orgId,
        accountId,
        asset.currency,
        asset.symbol,
        asset.decimals,
        asset.contractAddress,
        asset.chainId,
        asset.environment,
        asset.createdBy,
        asset.createdAt,
      );
    this.evidence.append({
      orgId: input.orgId,
      topic: 'financial',
      type: 'token_asset.registered',
      eventKey: `token-asset:${id}:registered`,
      payload: {
        tokenAssetId: id,
        currency: asset.currency,
        symbolSha256: sha256(asset.symbol),
        decimals: asset.decimals,
        contractAddress: asset.contractAddress,
        chainId: asset.chainId,
        environment: asset.environment,
        by: asset.createdBy,
      },
    });
    return asset;
  }

  getActive(orgId: string, currency: string): TokenAssetView | null {
    const row = this.db
      .prepare(
        'SELECT * FROM token_assets WHERE org_id = ? AND currency = ? AND revoked_at IS NULL',
      )
      .get(orgId, currency.trim().toUpperCase()) as Record<string, unknown> | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  isTokenCurrency(orgId: string, currency: string): boolean {
    return this.getActive(orgId, currency) !== null;
  }

  listTokenAssets(orgId: string): TokenAssetView[] {
    return (
      this.db
        .prepare('SELECT * FROM token_assets WHERE org_id = ? ORDER BY created_at DESC')
        .all(orgId) as unknown[]
    ).map((r) => this.mapRow(r));
  }

  /**
   * Records a chain-read token balance: an ordinary balance_snapshots row
   * (so spendable/reservation math applies unchanged) with source
   * 'metal-testnet' and the MANDATORY chain provenance triple. The minor
   * units are integer token minor units (decimals from the registry).
   */
  recordTokenBalanceSnapshot(input: {
    orgId: string;
    currency: string;
    minorUnits: number;
    chainId: number;
    contractAddress: string;
    observedAt?: string;
    chainReadAt: string;
    expiresAt?: string;
  }): { id: string; expiresAt: string } {
    const asset = this.getActive(input.orgId, input.currency);
    if (asset === null) {
      throw new LedgerError(
        'TOKEN_ASSET_NOT_REGISTERED',
        `currency ${input.currency} is not a registered token asset in this organization; fiat snapshots can never fund token orders`,
      );
    }
    if (asset.chainId !== input.chainId) {
      throw new LedgerError(
        'CHAIN_MISMATCH',
        `balance read is from chain ${input.chainId}; the registered token asset is on chain ${asset.chainId}`,
      );
    }
    if (asset.contractAddress !== input.contractAddress.trim().toLowerCase()) {
      throw new LedgerError(
        'TOKEN_CONTRACT_MISMATCH',
        'balance read contract does not match the registered token asset contract',
      );
    }
    if (!Number.isSafeInteger(input.minorUnits) || input.minorUnits < 0) {
      throw new LedgerError(
        'INVALID_AMOUNT',
        'token balance minor units must be a non-negative integer',
      );
    }
    if (typeof input.chainReadAt !== 'string' || !Number.isFinite(Date.parse(input.chainReadAt))) {
      throw new LedgerError('INVALID_INPUT', 'chainReadAt must be a valid ISO timestamp');
    }
    const chainReadMs = Date.parse(input.chainReadAt);
    createMoney(asset.currency, input.minorUnits);
    const observedAt = input.observedAt ?? this.clock.iso();
    if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) {
      throw new LedgerError('INVALID_INPUT', 'observedAt must be a valid ISO timestamp');
    }
    const observedMs = Date.parse(observedAt);
    // Future-dating refused first (30s skew window) — then temporal
    // ordering: the observation cannot precede the chain read it derives
    // from.
    const nowMs = this.clock.now().getTime();
    if (chainReadMs > nowMs + 30_000) {
      throw new LedgerError('INVALID_INPUT', 'future-dated chain reads cannot authorize spending');
    }
    if (observedMs > nowMs + 30_000) {
      throw new LedgerError(
        'INVALID_INPUT',
        'future-dated balance observations cannot authorize spending',
      );
    }
    if (observedMs < chainReadMs) {
      throw new LedgerError(
        'OBSERVATION_ORDER_INVALID',
        'balance observedAt precedes its chainReadAt — reversed temporal ordering',
      );
    }
    // Bounded chain-read freshness: a read older than CHAIN_READ_MAX_AGE_MS
    // is stale evidence — it can never back a "fresh" spendable (the 2020
    // counterexample).
    if (nowMs - chainReadMs > CHAIN_READ_MAX_AGE_MS) {
      throw new LedgerError(
        'CHAIN_READ_STALE',
        `chain read is older than ${CHAIN_READ_MAX_AGE_MS} ms — a fresh verified read is required before the token balance can authorize spending`,
      );
    }
    // Snapshot expiry: caller-supplied expiry is capped — a 2035 expiry on a
    // today-observed snapshot would keep a stale read "fresh" for years.
    const maxExpiresMs = observedMs + CHAIN_SNAPSHOT_MAX_TTL_MS;
    let expiresAt: string;
    if (input.expiresAt === undefined) {
      expiresAt = new Date(Math.min(observedMs + 5 * 60_000, maxExpiresMs)).toISOString();
    } else {
      if (!Number.isFinite(Date.parse(input.expiresAt))) {
        throw new LedgerError('INVALID_INPUT', 'expiresAt must be a valid ISO timestamp');
      }
      const expiresMs = Date.parse(input.expiresAt);
      if (expiresMs <= observedMs) {
        throw new LedgerError('INVALID_INPUT', 'balance observation timestamps must be ordered');
      }
      if (expiresMs > maxExpiresMs) {
        throw new LedgerError(
          'BALANCE_EXPIRY_EXCESSIVE',
          `token snapshot expiry exceeds the ${CHAIN_SNAPSHOT_MAX_TTL_MS} ms TTL — a stale chain read must never stay "fresh" for years`,
        );
      }
      expiresAt = input.expiresAt;
    }
    const id = newId('bal');
    this.db
      .prepare(
        `INSERT INTO balance_snapshots
           (id, account_id, org_id, currency, minor_units, source, observed_at, expires_at, recorded_at, chain_id, contract_address, chain_read_at)
         VALUES (?, ?, ?, ?, ?, 'metal-testnet', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        asset.accountId,
        input.orgId,
        asset.currency,
        input.minorUnits,
        observedAt,
        expiresAt,
        this.clock.iso(),
        input.chainId,
        asset.contractAddress,
        input.chainReadAt,
      );
    this.evidence.append({
      orgId: input.orgId,
      topic: 'financial',
      type: 'token_balance.observed',
      eventKey: `token-balance:${id}:observed`,
      payload: {
        snapshotId: id,
        currency: asset.currency,
        minorUnits: input.minorUnits,
        chainId: input.chainId,
        contractAddress: asset.contractAddress,
        chainReadAt: input.chainReadAt,
        observedAt,
        expiresAt,
      },
    });
    return { id, expiresAt };
  }

  /** Revokes a token asset: mandates/reservations for it fail closed afterwards. */
  revokeTokenAsset(orgId: string, currency: string, byActorId: string): boolean {
    const asset = this.getActive(orgId, currency);
    if (asset === null) return false;
    this.db
      .prepare('UPDATE token_assets SET revoked_at = ? WHERE id = ?')
      .run(this.clock.iso(), asset.id);
    this.evidence.append({
      orgId,
      topic: 'financial',
      type: 'token_asset.revoked',
      eventKey: `token-asset:${asset.id}:revoked:${this.clock.iso()}`,
      payload: { tokenAssetId: asset.id, currency: asset.currency, by: byActorId },
    });
    return true;
  }

  private mapRow(row: unknown): TokenAssetView {
    const r = row as Record<string, unknown>;
    return {
      id: text(r.id, 'id'),
      orgId: text(r.org_id, 'org_id'),
      accountId: text(r.account_id, 'account_id'),
      currency: text(r.currency, 'currency'),
      symbol: text(r.symbol, 'symbol'),
      decimals: Number(r.decimals),
      contractAddress: text(r.contract_address, 'contract_address'),
      chainId: Number(r.chain_id),
      environment: 'testnet',
      createdBy: text(r.created_by, 'created_by'),
      createdAt: text(r.created_at, 'created_at'),
      revokedAt: nullableText(r.revoked_at),
    };
  }
}

/** Constant-time comparison helper kept near the hashing it complements. */
export function digestMatches(candidate: string, stored: string): boolean {
  const a = Buffer.from(sha256(candidate), 'hex');
  const b = Buffer.from(stored, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Nonce material for Metal orders: unpredictable, persisted by the adapter. */
export function newNonceMaterial(): string {
  return randomBytes(16).toString('hex');
}
