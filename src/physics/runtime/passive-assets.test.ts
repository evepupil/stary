import { describe, expect, it } from 'vitest';

import { GRAVITATIONAL_CONSTANT_SI } from '../constants';
import { createPhysicsStateFromSnapshot } from '../protocol/physics-state';
import { physicsStateSchema } from '../protocol/schemas';
import type { PhysicsSnapshot } from './physics-simulation';
import { advancePhysicsStateToSnapshot, replacePhysicsStateAssets } from './passive-assets';
import { createTestBodyState } from '../../test/fixtures/body-state';

const diagnostics = {
  totalEnergyJoules: -1,
  totalLinearMomentumKgMetersPerSecond: { x: 0, y: 0, z: 0 },
  totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 0 },
} as const;

function required<Value>(value: Value | undefined, label: string): Value {
  if (value === undefined) {
    throw new Error(`测试缺少 ${label}`);
  }
  return value;
}

function majorSnapshot(): PhysicsSnapshot {
  return {
    bodies: [
      createTestBodyState({
        id: 'primary',
        massKg: 1e20,
        radiusMeters: 1e6,
      }),
    ],
    diagnostics,
  };
}

function stateWithTracer() {
  const snapshot = majorSnapshot();
  const base = createPhysicsStateFromSnapshot(snapshot);
  const radiusMeters = 1e7;
  const primary = required(snapshot.bodies[0], '主要天体');
  const circularSpeed = Math.sqrt((GRAVITATIONAL_CONSTANT_SI * primary.massKg) / radiusMeters);
  return replacePhysicsStateAssets(
    base,
    snapshot,
    [
      {
        id: 'tracer',
        massKg: 1e10,
        positionMeters: { x: radiusMeters, y: 0, z: 0 },
        velocityMetersPerSecond: { x: 0, y: circularSpeed, z: 0 },
        materialLayers: [{ material: 'silicate', massFraction: 1 }],
        subgridMechanicalEnergyJoules: 0,
      },
    ],
    [],
    base.cumulativeCollisionLedger,
  );
}

describe('passive asset propagation', () => {
  it('uses major-body gravity and accumulates the omitted reaction ledger', () => {
    const previous = stateWithTracer();
    const next = advancePhysicsStateToSnapshot(previous, majorSnapshot(), 1_000);
    const beforeTracer = required(previous.tracers[0], '推进前 tracer');
    const afterTracer = required(next.tracers[0], '推进后 tracer');

    expect(afterTracer.positionMeters.x).toBeLessThan(beforeTracer.positionMeters.x);
    expect(afterTracer.positionMeters.y).toBeGreaterThan(0);
    expect(afterTracer.velocityMetersPerSecond.x).toBeLessThan(0);
    expect(next.diagnostics.passiveAssets.totalMassKg).toBe(beforeTracer.massKg);
    expect(next.cumulativeOmittedBackreaction.linearImpulseKgMetersPerSecond.x).toBeCloseTo(
      -beforeTracer.massKg *
        (afterTracer.velocityMetersPerSecond.x - beforeTracer.velocityMetersPerSecond.x),
      6,
    );
    expect(Number.isFinite(next.cumulativeOmittedBackreaction.workJoules)).toBe(true);
    expect(next.cumulativeOmittedBackreaction.workJoules).not.toBe(0);
  });

  it('keeps empty passive reservoirs stable while refreshing active diagnostics', () => {
    const initialSnapshot = majorSnapshot();
    const previous = createPhysicsStateFromSnapshot(initialSnapshot);
    const nextSnapshot = {
      ...initialSnapshot,
      diagnostics: { ...diagnostics, totalEnergyJoules: -2 },
    };

    const next = advancePhysicsStateToSnapshot(previous, nextSnapshot, 10);

    expect(next.tracers).toEqual([]);
    expect(next.dustCohorts).toEqual([]);
    expect(next.diagnostics.activeRebound.totalEnergyJoules).toBe(-2);
    expect(next.cumulativeOmittedBackreaction).toEqual(previous.cumulativeOmittedBackreaction);
  });

  it('rejects an undefined force direction at a major-body center', () => {
    const snapshot = majorSnapshot();
    const base = createPhysicsStateFromSnapshot(snapshot);
    const invalid = physicsStateSchema.parse({
      ...base,
      tracers: [
        {
          id: 'centered-tracer',
          massKg: 1,
          positionMeters: { x: 0, y: 0, z: 0 },
          velocityMetersPerSecond: { x: 1, y: 0, z: 0 },
          materialLayers: [{ material: 'iron', massFraction: 1 }],
          subgridMechanicalEnergyJoules: 0,
        },
      ],
      diagnostics: {
        activeRebound: diagnostics,
        passiveAssets: {
          totalMassKg: 1,
          totalLinearMomentumKgMetersPerSecond: { x: 1, y: 0, z: 0 },
          totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 0 },
          totalMechanicalEnergyJoules: 0,
        },
      },
    });

    expect(() => advancePhysicsStateToSnapshot(invalid, snapshot, 1)).toThrow('中心重合');
  });
});
