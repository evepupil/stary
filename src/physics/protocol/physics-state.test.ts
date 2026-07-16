import { describe, expect, it } from 'vitest';

import { createTestBodyState } from '../../test/fixtures/body-state';
import { MAX_COLLISION_PASSIVE_ASSETS } from '../collisions/model-sources';
import {
  advanceCollisionLedgerSummary,
  collisionLedgerSummariesEqual,
  createEmptyCollisionLedgerSummary,
} from './collision-ledger-summary';
import { createPhysicsStateFromSnapshot } from './physics-state';
import { physicsStateSchema } from './schemas';

const initialDiagnostics = {
  totalEnergyJoules: -10,
  totalLinearMomentumKgMetersPerSecond: { x: 1, y: 2, z: 3 },
  totalAngularMomentumKgMetersSquaredPerSecond: { x: 4, y: 5, z: 6 },
} as const;

describe('createPhysicsStateFromSnapshot', () => {
  it('为首帧建立空被动层和双层诊断', () => {
    const body = createTestBodyState();
    const state = createPhysicsStateFromSnapshot({
      bodies: [body],
      diagnostics: initialDiagnostics,
    });

    expect(state.majorBodies).toEqual([body]);
    expect(state.tracers).toEqual([]);
    expect(state.dustCohorts).toEqual([]);
    expect(state.cumulativeCollisionLedger.resolvedEventCount).toBe(0);
    expect(state.diagnostics.activeRebound).toEqual(initialDiagnostics);
    expect(state.diagnostics.passiveAssets.totalMassKg).toBe(0);
  });

  it('后续 REBOUND 快照保留碰撞累计量与被动资产', () => {
    const previous = physicsStateSchema.parse({
      ...createPhysicsStateFromSnapshot({
        bodies: [createTestBodyState({ id: 'before' })],
        diagnostics: initialDiagnostics,
      }),
      tracers: [
        {
          id: 'tracer-1',
          massKg: 2,
          positionMeters: { x: 1, y: 0, z: 0 },
          velocityMetersPerSecond: { x: 0, y: 1, z: 0 },
          materialLayers: [{ material: 'silicate', massFraction: 1 }],
          subgridMechanicalEnergyJoules: 3,
        },
      ],
      dustCohorts: [
        {
          id: 'dust-1',
          massKg: 4,
          positionMeters: { x: 2, y: 0, z: 0 },
          velocityMetersPerSecond: { x: 0, y: 2, z: 0 },
          materialLayers: [{ material: 'iron', massFraction: 1 }],
          subgridMechanicalEnergyJoules: 5,
        },
      ],
      cumulativeCollisionLedger: {
        resolvedEventCount: 7,
        accumulatedDissipation: {
          heatJoules: 11,
          deformationJoules: 12,
          fractureJoules: 13,
          radiationJoules: 14,
        },
      },
      cumulativeOmittedBackreaction: {
        linearImpulseKgMetersPerSecond: { x: 15, y: 16, z: 17 },
        angularImpulseKgMetersSquaredPerSecond: { x: 18, y: 19, z: 20 },
        workJoules: 21,
      },
      diagnostics: {
        activeRebound: initialDiagnostics,
        passiveAssets: {
          totalMassKg: 6,
          totalLinearMomentumKgMetersPerSecond: { x: 0, y: 10, z: 0 },
          totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 18 },
          totalMechanicalEnergyJoules: 28,
        },
      },
    });
    const nextDiagnostics = {
      totalEnergyJoules: -20,
      totalLinearMomentumKgMetersPerSecond: { x: 30, y: 31, z: 32 },
      totalAngularMomentumKgMetersSquaredPerSecond: { x: 33, y: 34, z: 35 },
    };
    const nextBody = createTestBodyState({ id: 'after', massKg: 9 });

    const next = createPhysicsStateFromSnapshot(
      { bodies: [nextBody], diagnostics: nextDiagnostics },
      previous,
    );

    expect(next.majorBodies).toEqual([nextBody]);
    expect(next.diagnostics.activeRebound).toEqual(nextDiagnostics);
    expect(next.tracers).toEqual(previous.tracers);
    expect(next.dustCohorts).toEqual(previous.dustCohorts);
    expect(next.cumulativeCollisionLedger).toEqual(previous.cumulativeCollisionLedger);
    expect(next.cumulativeOmittedBackreaction).toEqual(previous.cumulativeOmittedBackreaction);
    expect(next.diagnostics.passiveAssets).toEqual(previous.diagnostics.passiveAssets);
  });

  it('拒绝 tracer 与 dust cohort 合计超过被动资产容量', () => {
    const passiveAsset = (id: string) => ({
      id,
      massKg: 1,
      positionMeters: { x: 0, y: 0, z: 0 },
      velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
      materialLayers: [{ material: 'silicate' as const, massFraction: 1 }],
      subgridMechanicalEnergyJoules: 0,
    });
    const tracerCount = MAX_COLLISION_PASSIVE_ASSETS / 2 + 1;
    const dustCount = MAX_COLLISION_PASSIVE_ASSETS - tracerCount + 1;
    const base = createPhysicsStateFromSnapshot({
      bodies: [createTestBodyState()],
      diagnostics: initialDiagnostics,
    });

    expect(() =>
      physicsStateSchema.parse({
        ...base,
        tracers: Array.from({ length: tracerCount }, (_, index) =>
          passiveAsset(`tracer-${String(index)}`),
        ),
        dustCohorts: Array.from({ length: dustCount }, (_, index) =>
          passiveAsset(`dust-${String(index)}`),
        ),
      }),
    ).toThrow('合计不能超过');
  });

  it('拒绝被动资产诊断与 tracer/dust cohort 的质量和动量不一致', () => {
    const base = createPhysicsStateFromSnapshot({
      bodies: [createTestBodyState()],
      diagnostics: initialDiagnostics,
    });
    expect(() =>
      physicsStateSchema.parse({
        ...base,
        tracers: [
          {
            id: 'tracer',
            massKg: 2,
            positionMeters: { x: 1, y: 0, z: 0 },
            velocityMetersPerSecond: { x: 0, y: 3, z: 0 },
            materialLayers: [{ material: 'silicate', massFraction: 1 }],
            subgridMechanicalEnergyJoules: 0,
          },
        ],
      }),
    ).toThrow('诊断总质量');
  });

  it('按批次增量累计事件数与四类耗散', () => {
    const next = advanceCollisionLedgerSummary(createEmptyCollisionLedgerSummary(), [
      {
        dissipation: {
          heatJoules: 1,
          deformationJoules: 2,
          fractureJoules: 3,
          radiationJoules: 4,
        },
      },
      {
        dissipation: {
          heatJoules: 5,
          deformationJoules: 6,
          fractureJoules: 7,
          radiationJoules: 8,
        },
      },
    ]);

    expect(next).toEqual({
      resolvedEventCount: 2,
      accumulatedDissipation: {
        heatJoules: 6,
        deformationJoules: 8,
        fractureJoules: 10,
        radiationJoules: 12,
      },
    });
    expect(collisionLedgerSummariesEqual(next, { ...next })).toBe(true);
  });
});
