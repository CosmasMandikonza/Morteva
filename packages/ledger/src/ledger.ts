/**
 * Ledger facade: one object wiring the database, migrations and services.
 * Typical startup: openLedger(path) → migrate → verify integrity → serve.
 */
import type { Clock } from './clock.js';
import { SystemClock } from './clock.js';
import type { LedgerDatabase } from './db/port.js';
import { openSqliteDatabase, backupSqliteDatabase } from './db/sqlite.js';
import { migrate, currentSchemaVersion, type MigrationReport } from './db/migrator.js';
import { OrganizationService } from './services/organizations.js';
import { AccountService } from './services/accounts.js';
import { MandateService } from './services/mandates.js';
import { ApprovalService, PlanService } from './services/plans.js';
import { AuthorityService } from './services/authority.js';
import { ExternalIdentityService } from './services/external-identity.js';
import { SpendableService } from './services/spendable.js';
import { ReservationService } from './services/reservations.js';
import { EvidenceService } from './services/evidence.js';
import { OutboxService } from './services/outbox.js';
import { RecoveryService } from './services/recovery.js';
import { DispatchWorker } from './services/worker.js';
import { ProviderReceiptService } from './services/provider-receipts.js';

export class Ledger {
  readonly organizations: OrganizationService;
  readonly accounts: AccountService;
  readonly mandates: MandateService;
  readonly plans: PlanService;
  readonly approvals: ApprovalService;
  readonly authority: AuthorityService;
  readonly identity: ExternalIdentityService;
  readonly spendable: SpendableService;
  readonly reservations: ReservationService;
  readonly evidence: EvidenceService;
  readonly outbox: OutboxService;
  readonly recovery: RecoveryService;
  readonly providerReceipts: ProviderReceiptService;
  readonly worker: DispatchWorker;

  constructor(
    readonly db: LedgerDatabase,
    readonly clock: Clock,
  ) {
    this.organizations = new OrganizationService(db, clock);
    this.accounts = new AccountService(db, clock);
    this.evidence = new EvidenceService(db, clock);
    this.authority = new AuthorityService(db, clock, this.organizations, this.evidence);
    this.identity = new ExternalIdentityService(db, clock, this.organizations, this.evidence);
    this.mandates = new MandateService(db, clock, this.evidence);
    this.plans = new PlanService(db, clock);
    this.approvals = new ApprovalService(db, clock, this.authority, this.evidence, this.mandates);
    this.spendable = new SpendableService(db, clock, this.accounts);
    this.reservations = new ReservationService(
      db,
      clock,
      this.organizations,
      this.mandates,
      this.plans,
      this.approvals,
      this.spendable,
      this.evidence,
    );
    this.outbox = new OutboxService(db, clock);
    this.recovery = new RecoveryService(db, clock, this.outbox);
    this.providerReceipts = new ProviderReceiptService(db, clock);
    this.worker = new DispatchWorker(
      db,
      clock,
      this.outbox,
      this.reservations,
      this.mandates,
      this.evidence,
    );
  }

  migrate(): MigrationReport {
    return migrate(this.db);
  }

  schemaVersion(): number {
    return currentSchemaVersion(this.db);
  }

  backupTo(targetPath: string): void {
    backupSqliteDatabase(this.db, targetPath);
  }

  close(): void {
    this.db.close();
  }
}

export function openLedger(path: string, clock: Clock = new SystemClock()): Ledger {
  return new Ledger(openSqliteDatabase(path), clock);
}
