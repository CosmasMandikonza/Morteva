import type { LedgerDatabase } from '../db/port.js';
import { text } from '../db/port.js';
import { LedgerError } from '../errors.js';
import type { Clock } from '../clock.js';
import { newId } from './identity.js';
import type { MissionStatus, MissionView, OrganizationView } from '@moterva/domain';

export class OrganizationService {
  constructor(
    private readonly db: LedgerDatabase,
    private readonly clock: Clock,
  ) {}

  createOrganization(name: string): OrganizationView {
    if (name.trim() === '')
      throw new LedgerError('INVALID_INPUT', 'organization name must not be empty');
    const org: OrganizationView = {
      id: newId('org'),
      name: name.trim(),
      createdAt: this.clock.iso(),
    };
    this.db
      .prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)')
      .run(org.id, org.name, org.createdAt);
    return org;
  }

  createMission(orgId: string, title: string): MissionView {
    this.requireOrganization(orgId);
    const mission: MissionView = {
      id: newId('msn'),
      orgId,
      title: title.trim(),
      status: 'active',
      createdAt: this.clock.iso(),
    };
    this.db
      .prepare(
        'INSERT INTO missions (id, org_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(mission.id, mission.orgId, mission.title, mission.status, mission.createdAt);
    return mission;
  }

  /** Org-scoped read: another org's mission is indistinguishable from a missing one. */
  getMission(orgId: string, missionId: string): MissionView {
    const row = this.db
      .prepare(
        'SELECT id, org_id, title, status, created_at FROM missions WHERE id = ? AND org_id = ?',
      )
      .get(missionId, orgId);
    if (row === undefined) {
      throw new LedgerError(
        'MISSION_NOT_FOUND',
        `mission ${missionId} not found in organization ${orgId}`,
      );
    }
    const r = row as Record<string, unknown>;
    return {
      id: text(r.id, 'id'),
      orgId: text(r.org_id, 'org_id'),
      title: text(r.title, 'title'),
      status: text(r.status, 'status') as MissionStatus,
      createdAt: text(r.created_at, 'created_at'),
    };
  }

  requireActiveMission(orgId: string, missionId: string): MissionView {
    const mission = this.getMission(orgId, missionId);
    if (mission.status !== 'active') {
      throw new LedgerError(
        'MISSION_INACTIVE',
        `mission ${missionId} is ${mission.status}, not active`,
        {
          status: mission.status,
        },
      );
    }
    return mission;
  }

  requireOrganization(orgId: string): void {
    const row = this.db.prepare('SELECT id FROM organizations WHERE id = ?').get(orgId);
    if (row === undefined) {
      throw new LedgerError('CROSS_ORG_ACCESS', `organization ${orgId} not found`);
    }
  }
}
