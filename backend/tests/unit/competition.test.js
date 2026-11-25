import { describe, expect, it } from 'vitest';
import { computeRemainingSeconds } from '../../src/modules/competition/competition.service.js';
import {
  validateCompetitionConfigBody,
  validateConfirmRanksBody,
  validateExcludeTeamBody,
  validateImportRanksBody,
  validateLockRosterBody
} from '../../src/modules/competition/competition.validation.js';
import { calculateHeadStart } from '../../src/modules/competition/headStart.js';

describe('Phase 04 head-start calculation, timer math, and validation (unit)', () => {
  it('computes Round 1 head starts accurately for 50 ranked teams and single-team special case', () => {
    expect(calculateHeadStart(1, 50, 20)).toBe(20);
    expect(calculateHeadStart(5, 50, 20)).toBe(18);
    expect(calculateHeadStart(25, 50, 20)).toBe(10);
    expect(calculateHeadStart(50, 50, 20)).toBe(0);

    // Single ranked team special case
    expect(calculateHeadStart(1, 1, 20)).toBe(20);
    expect(calculateHeadStart(1, 1, 15)).toBe(15);
  });

  it('rejects invalid head-start arguments instead of silently clamping', () => {
    expect(() => calculateHeadStart(0, 50, 20)).toThrow();
    expect(() => calculateHeadStart(51, 50, 20)).toThrow();
    expect(() => calculateHeadStart(-1, 50, 20)).toThrow();
    expect(() => calculateHeadStart(1.5, 50, 20)).toThrow();
    expect(() => calculateHeadStart(1, 0, 20)).toThrow();
    expect(() => calculateHeadStart(1, 10, -5)).toThrow();
  });

  it('computes non-negative remainingSeconds using ceiling rounding policy', () => {
    const endsAt = new Date('2026-11-25T12:30:00.000Z');
    expect(computeRemainingSeconds(null, Date.now())).toBeNull();
    expect(
      computeRemainingSeconds(endsAt, new Date('2026-11-25T12:29:59.100Z').getTime())
    ).toBe(1);
    expect(
      computeRemainingSeconds(endsAt, new Date('2026-11-25T12:30:00.000Z').getTime())
    ).toBe(0);
    expect(
      computeRemainingSeconds(endsAt, new Date('2026-11-25T12:35:00.000Z').getTime())
    ).toBe(0);
  });

  it('validates rank import payloads and rejects duplicates or out-of-range ranks', () => {
    const valid = validateImportRanksBody({
      rankedTeamCount: 50,
      entries: [
        { teamId: '674400000000000000000001', rank: 1 },
        { teamId: '674400000000000000000002', rank: 50 }
      ]
    });
    expect(valid.rankedTeamCount).toBe(50);

    expect(() =>
      validateImportRanksBody({
        rankedTeamCount: 10,
        entries: [{ teamId: '674400000000000000000001', rank: 11 }]
      })
    ).toThrow(/exceeds rankedTeamCount/);

    expect(() =>
      validateImportRanksBody({
        rankedTeamCount: 10,
        entries: [
          { teamId: '674400000000000000000001', rank: 1 },
          { teamId: '674400000000000000000002', rank: 1 }
        ]
      })
    ).toThrow(/Duplicate rank/);

    expect(() =>
      validateImportRanksBody({
        rankedTeamCount: 10,
        entries: [
          { teamId: '674400000000000000000001', rank: 1 },
          { teamId: '674400000000000000000001', rank: 2 }
        ]
      })
    ).toThrow(/Duplicate teamId/);
  });

  it('validates confirmation, exclusion, lock versions, and strict config allowlist', () => {
    expect(validateConfirmRanksBody({ rankImportVersion: 2 })).toEqual({
      rankImportVersion: 2
    });
    expect(() => validateConfirmRanksBody({})).toThrow();

    expect(validateExcludeTeamBody({ reason: '  Incomplete team  ' })).toEqual({
      reason: 'Incomplete team'
    });
    expect(() => validateExcludeTeamBody({ reason: 'no' })).toThrow();

    expect(
      validateLockRosterBody({ expectedRosterVersion: 5, expectedRankImportVersion: 1 })
    ).toEqual({
      expectedRosterVersion: 5,
      expectedRankImportVersion: 1
    });

    expect(
      validateCompetitionConfigBody({ durationSeconds: 15, maxHeadStart: 20 })
    ).toEqual({
      durationSeconds: 15,
      maxHeadStart: 20
    });

    // Rejects arbitrary/unallowlisted fields
    expect(() =>
      validateCompetitionConfigBody({ status: 'LIVE', teamSize: 10 })
    ).toThrow();
    expect(() => validateCompetitionConfigBody({})).toThrow();
  });
});
