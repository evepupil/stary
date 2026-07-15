import { describe, expect, it } from 'vitest';

import { computeCollisionLedger } from './conservation';
import type { CollisionDissipation, CollisionEventState } from './schemas';
import { collisionBody } from './test-helpers';

const ZERO_DISSIPATION: CollisionDissipation = {
  heatJoules: 0,
  deformationJoules: 0,
  fractureJoules: 0,
  radiationJoules: 0,
};

function ledger(
  before: CollisionEventState,
  after: CollisionEventState,
  dissipation: CollisionDissipation = ZERO_DISSIPATION,
) {
  const first = before.majorBodies[0];
  const second = before.majorBodies[1];
  if (first === undefined || second === undefined) {
    throw new Error('测试账本至少需要两个碰前主要天体');
  }
  return computeCollisionLedger({
    eventId: 'event-ledger',
    simulationTimeSeconds: 100,
    before,
    after,
    dissipation,
    participantBodyIds: [first.id, second.id],
  });
}

describe('event-total 守恒账本', () => {
  it('完全非弹性正碰将机械能差落入热量并通过四项门槛', () => {
    const before: CollisionEventState = {
      majorBodies: [
        collisionBody({
          id: 'a',
          massKg: 1e10,
          radiusMeters: 1,
          positionMeters: { x: -1, y: 0, z: 0 },
          velocityMetersPerSecond: { x: 1, y: 0, z: 0 },
        }),
        collisionBody({
          id: 'b',
          massKg: 1e10,
          radiusMeters: 1,
          positionMeters: { x: 1, y: 0, z: 0 },
          velocityMetersPerSecond: { x: -1, y: 0, z: 0 },
        }),
      ],
      tracers: [],
      dustCohorts: [],
    };
    const after: CollisionEventState = {
      majorBodies: [
        collisionBody({
          id: 'merged',
          massKg: 2e10,
          radiusMeters: Math.cbrt(2),
        }),
      ],
      tracers: [],
      dustCohorts: [],
    };
    const withoutHeat = ledger(before, after);
    const heatJoules = withoutHeat.before.energy.totalJoules - withoutHeat.after.energy.totalJoules;
    expect(heatJoules).toBeGreaterThan(0);

    const result = ledger(before, after, { ...ZERO_DISSIPATION, heatJoules });
    expect(result.passed).toBe(true);
    expect(result.checks.mass.normalizedError).toBe(0);
    expect(result.checks.linearMomentum.normalizedError).toBe(0);
    expect(result.checks.angularMomentum.normalizedError).toBe(0);
    expect(result.checks.energy.normalizedError).toBeLessThanOrEqual(1e-15);
    expect(result.omittedInteractionClasses).toContain('passiveBackreaction');
  });

  it('同时检查材料质量并拒绝静默材料转化', () => {
    const beforeBody = collisionBody({
      id: 'body',
      massKg: 1e10,
      radiusMeters: 1,
      positionMeters: { x: -1, y: 0, z: 0 },
      velocityMetersPerSecond: { x: 1, y: 0, z: 0 },
    });
    const afterBody = collisionBody({
      id: 'body',
      massKg: 1e10,
      radiusMeters: 1,
      positionMeters: { x: -1, y: 0, z: 0 },
      velocityMetersPerSecond: { x: 1, y: 0, z: 0 },
      materialLayers: [{ material: 'silicate', massFraction: 1 }],
    });
    const partner = collisionBody({
      id: 'partner',
      massKg: 1e10,
      radiusMeters: 1,
      positionMeters: { x: 1, y: 0, z: 0 },
      velocityMetersPerSecond: { x: -1, y: 0, z: 0 },
    });
    const result = ledger(
      { majorBodies: [beforeBody, partner], tracers: [], dustCohorts: [] },
      { majorBodies: [afterBody, partner], tracers: [], dustCohorts: [] },
    );
    expect(result.checks.mass.passed).toBe(true);
    expect(result.checks.materialMasses.iron.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('小于 1 kg 的系统仍按碰前总质量计算相对误差', () => {
    const first = collisionBody({
      id: 'tiny-a',
      massKg: 1e-20,
      radiusMeters: 1,
      positionMeters: { x: -1, y: 0, z: 0 },
      velocityMetersPerSecond: { x: 1, y: 0, z: 0 },
    });
    const second = collisionBody({
      id: 'tiny-b',
      massKg: 1e-20,
      radiusMeters: 1,
      positionMeters: { x: 1, y: 0, z: 0 },
      velocityMetersPerSecond: { x: -1, y: 0, z: 0 },
    });
    const result = ledger(
      { majorBodies: [first, second], tracers: [], dustCohorts: [] },
      {
        majorBodies: [{ ...first, massKg: 2e-20 }, second],
        tracers: [],
        dustCohorts: [],
      },
    );
    expect(result.checks.mass.scale).toBe(2e-20);
    expect(result.checks.mass.normalizedError).toBeCloseTo(0.5, 12);
    expect(result.checks.mass.passed).toBe(false);
  });

  it('使用碰前质心系处理近零总动量并保持有限误差尺度', () => {
    const state: CollisionEventState = {
      majorBodies: [
        collisionBody({
          id: 'a',
          massKg: 1e10,
          radiusMeters: 1,
          positionMeters: { x: -1, y: 0, z: 0 },
          velocityMetersPerSecond: { x: 1, y: 0, z: 0 },
        }),
        collisionBody({
          id: 'b',
          massKg: 1e10,
          radiusMeters: 1,
          positionMeters: { x: 1, y: 0, z: 0 },
          velocityMetersPerSecond: { x: -1, y: 0, z: 0 },
        }),
      ],
      tracers: [],
      dustCohorts: [],
    };
    const result = ledger(state, state);
    expect(result.referenceFrame.velocityMetersPerSecond).toEqual({ x: 0, y: 0, z: 0 });
    expect(result.checks.linearMomentum.scale).toBeGreaterThan(0);
    expect(result.checks.linearMomentum.normalizedError).toBe(0);
    expect(result.passed).toBe(true);
  });

  it('允许无关黑洞留在完整事件状态中', () => {
    const first = collisionBody({
      id: 'a',
      massKg: 10,
      radiusMeters: 1,
      positionMeters: { x: -1, y: 0, z: 0 },
      velocityMetersPerSecond: { x: 1, y: 0, z: 0 },
    });
    const second = collisionBody({
      id: 'b',
      massKg: 10,
      radiusMeters: 1,
      positionMeters: { x: 1, y: 0, z: 0 },
      velocityMetersPerSecond: { x: -1, y: 0, z: 0 },
    });
    const blackHole = {
      ...collisionBody({
        id: 'distant-black-hole',
        massKg: 1e6,
        radiusMeters: 10,
        positionMeters: { x: 1e6, y: 0, z: 0 },
      }),
      collisionModel: 'blackHole' as const,
      materialLayers: [],
      momentOfInertiaFactor: null,
    };
    const state = { majorBodies: [first, second, blackHole], tracers: [], dustCohorts: [] };
    expect(ledger(state, state).passed).toBe(true);
  });

  it('计算自转、主要体势能、被动势能和 subgrid 能量', () => {
    const state: CollisionEventState = {
      majorBodies: [
        collisionBody({
          id: 'major-a',
          massKg: 10,
          radiusMeters: 2,
          positionMeters: { x: -1, y: 0, z: 0 },
          velocityMetersPerSecond: { x: 1, y: 0, z: 0 },
          spinAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 4 },
        }),
        collisionBody({
          id: 'major-b',
          massKg: 5,
          radiusMeters: 1,
          positionMeters: { x: 2, y: 0, z: 0 },
          velocityMetersPerSecond: { x: -1, y: 0, z: 0 },
        }),
      ],
      tracers: [
        {
          id: 'tracer',
          massKg: 1,
          positionMeters: { x: 5, y: 0, z: 0 },
          velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
          materialLayers: [{ material: 'silicate', massFraction: 1 }],
          subgridMechanicalEnergyJoules: 0,
        },
      ],
      dustCohorts: [
        {
          id: 'dust',
          massKg: 1,
          positionMeters: { x: 6, y: 0, z: 0 },
          velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
          materialLayers: [{ material: 'silicate', massFraction: 1 }],
          subgridMechanicalEnergyJoules: 12,
        },
      ],
    };
    const result = ledger(state, state);
    expect(result.before.energy.spinJoules).toBeCloseTo(0.5, 12);
    expect(result.before.energy.activeActivePotentialJoules).toBeLessThan(0);
    expect(result.before.energy.activePassivePotentialJoules).toBeLessThan(0);
    expect(result.before.energy.subgridJoules).toBe(12);
  });

  it('拒绝负耗散、重合资产和经典账本中的黑洞', () => {
    const body = collisionBody({
      id: 'body',
      massKg: 1e10,
      radiusMeters: 1,
      positionMeters: { x: -1, y: 0, z: 0 },
      velocityMetersPerSecond: { x: 1, y: 0, z: 0 },
    });
    const partner = collisionBody({
      id: 'partner',
      massKg: 1e10,
      radiusMeters: 1,
      positionMeters: { x: 1, y: 0, z: 0 },
      velocityMetersPerSecond: { x: -1, y: 0, z: 0 },
    });
    const state = { majorBodies: [body, partner], tracers: [], dustCohorts: [] };
    expect(() => ledger(state, state, { ...ZERO_DISSIPATION, heatJoules: -1 })).toThrow();

    const coincident: CollisionEventState = {
      majorBodies: [body, partner],
      tracers: [
        {
          id: 'tracer',
          massKg: 1,
          positionMeters: body.positionMeters,
          velocityMetersPerSecond: body.velocityMetersPerSecond,
          materialLayers: [{ material: 'silicate', massFraction: 1 }],
          subgridMechanicalEnergyJoules: 0,
        },
      ],
      dustCohorts: [],
    };
    expect(() => ledger(coincident, coincident)).toThrow('中心距离');

    const blackHole = {
      ...body,
      collisionModel: 'blackHole' as const,
      materialLayers: [],
      momentOfInertiaFactor: null,
    };
    expect(() =>
      ledger(
        { majorBodies: [blackHole, partner], tracers: [], dustCohorts: [] },
        { majorBodies: [blackHole, partner], tracers: [], dustCohorts: [] },
      ),
    ).toThrow('独立牛顿吞噬账本');

    const stellar = { ...body, id: 'stellar', collisionModel: 'stellar' as const };
    const stellarState = { majorBodies: [stellar, partner], tracers: [], dustCohorts: [] };
    expect(() => ledger(stellarState, stellarState)).toThrow('恒星碰撞');
  });
});
