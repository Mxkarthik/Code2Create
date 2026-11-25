import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { TEAM_STATUSES } from '../../src/modules/teams/team.model.js';
import {
  deriveTeamStatus,
  generateJoinCode
} from '../../src/modules/teams/team.service.js';
import {
  JOIN_CODE_PATTERN,
  validateCreateTeamBody,
  validateJoinTeamBody,
  validateMemberIdParam,
  validateSetReadyBody,
  validateTransferLeadershipBody
} from '../../src/modules/teams/team.validation.js';
import { LOG_FORMATS, createLogger } from '../../src/utils/logger.js';

describe('Team validation, join codes, status derivation, and redaction (unit)', () => {
  it('validates and trims team creation payloads', () => {
    expect(validateCreateTeamBody({ name: '  Code Warriors  ' })).toEqual({
      name: 'Code Warriors'
    });

    expect(() => validateCreateTeamBody({ name: 'ab' })).toThrow(/3 and 40/);
    expect(() => validateCreateTeamBody({ name: 'x'.repeat(41) })).toThrow(/3 and 40/);
    expect(() => validateCreateTeamBody({})).toThrow();
  });

  it('normalizes and validates 8-character unambiguous invitation codes', () => {
    expect(validateJoinTeamBody({ joinCode: '  k7mx4p9r ' })).toEqual({
      joinCode: 'K7MX4P9R'
    });

    expect(() => validateJoinTeamBody({ joinCode: 'SHORT' })).toThrow();
    expect(() => validateJoinTeamBody({ joinCode: 'ABCDO0I1' })).toThrow();
    expect(() => validateJoinTeamBody({})).toThrow();
  });

  it('generates cryptographically random unambiguous join codes excluding O, 0, I, 1', () => {
    const generated = new Set();
    for (let i = 0; i < 100; i += 1) {
      const code = generateJoinCode();
      expect(code).toMatch(JOIN_CODE_PATTERN);
      expect(code).not.toMatch(/[O0I1]/);
      generated.add(code);
    }
    expect(generated.size).toBe(100);
  });

  it('derives team statuses accurately from membership and readiness counts', () => {
    expect(deriveTeamStatus({ memberCount: 0, readyMemberCount: 0, teamSize: 2 })).toBe(
      TEAM_STATUSES.DISSOLVED
    );
    expect(deriveTeamStatus({ memberCount: 1, readyMemberCount: 0, teamSize: 2 })).toBe(
      TEAM_STATUSES.FORMING
    );
    expect(deriveTeamStatus({ memberCount: 1, readyMemberCount: 1, teamSize: 2 })).toBe(
      TEAM_STATUSES.FORMING
    );
    expect(deriveTeamStatus({ memberCount: 2, readyMemberCount: 1, teamSize: 2 })).toBe(
      TEAM_STATUSES.FORMED
    );
    expect(deriveTeamStatus({ memberCount: 2, readyMemberCount: 2, teamSize: 2 })).toBe(
      TEAM_STATUSES.READY
    );
  });

  it('validates readiness, leadership transfer, and member ID params strictly', () => {
    expect(validateSetReadyBody({ isReady: true })).toEqual({ isReady: true });
    expect(() => validateSetReadyBody({ isReady: 'true' })).toThrow();

    expect(() => validateTransferLeadershipBody({ targetUserId: 'not-an-id' })).toThrow();
    expect(() => validateMemberIdParam('invalid-id')).toThrow();
  });

  it('redacts joinCode and inviteCode in structured logs', () => {
    const chunks = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString('utf8'));
        cb();
      }
    });
    const logger = createLogger({
      level: 'info',
      format: LOG_FORMATS.JSON,
      destination: stream
    });

    logger.info({ joinCode: 'K7MX4P9R', nested: { inviteCode: 'ABCD2345' } }, 'Team event');
    const raw = chunks.join('');
    expect(raw).not.toContain('K7MX4P9R');
    expect(raw).not.toContain('ABCD2345');
  });
});
