import { describe, expect, it } from 'vitest';

import { computeContactQuantities } from './contact-quantities';
import { computeDisruptionScaling } from './disruption-scaling';
import {
  COLLISION_KERNEL_ABI_VERSION,
  COLLISION_RECONSTRUCTION_VERSION,
  collisionKernelBatchRequestSchema,
  collisionKernelResponseSchema,
  type CollisionKernelBatchRequest,
} from './kernel-schemas';
import { resolveCollisionKernelReference } from './kernel-reference';
import { COLLISION_MODEL_VERSION } from './model-sources';
import type { CollisionBodySnapshot } from './schemas';
import { contactBodies } from './test-helpers';
import { dot, subtract } from './vector';

function classicRequest(
  eventId: string,
  bodies: readonly [CollisionBodySnapshot, CollisionBodySnapshot],
  capacity = { majorRemnantSlots: 2, passiveAssetSlots: 1 },
): CollisionKernelBatchRequest {
  return {
    abiVersion: COLLISION_KERNEL_ABI_VERSION,
    modelVersion: COLLISION_MODEL_VERSION,
    reconstructionVersion: COLLISION_RECONSTRUCTION_VERSION,
    capacity,
    events: [
      {
        domain: 'classic',
        input: {
          eventId,
          simulationTimeSeconds: 42,
          firstBody: bodies[0],
          secondBody: bodies[1],
        },
        expectedMaterialProfile: 'gravitySolid',
      },
    ],
  };
}

function expectSuccess(input: unknown) {
  const response = resolveCollisionKernelReference(input);
  if (response.kind !== 'success') {
    throw new Error(response.error.message);
  }
  expect(response.kind).toBe('success');
  return response;
}

describe('工程确定性碰撞内核参考实现', () => {
  it('把低速正碰重建成一个守恒合并残体', () => {
    const bodies = contactBodies({
      targetMassKg: 4e21,
      projectileMassKg: 2e21,
      targetRadiusMeters: 700_000,
      projectileRadiusMeters: 500_000,
      impactSpeedMetersPerSecond: 1,
    });
    const response = expectSuccess(classicRequest('event-merge', bodies));
    const resolution = response.events[0];
    expect(resolution?.domain).toBe('classic');
    if (resolution?.domain !== 'classic') {
      throw new Error('预期经典碰撞结果');
    }
    expect(resolution.candidate.classification).toBe('merge');
    expect(resolution.after.majorBodies).toHaveLength(1);
    expect(resolution.after.tracers).toHaveLength(0);
    expect(resolution.after.dustCohorts).toHaveLength(0);
    expect(resolution.after.majorBodies[0]?.massKg).toBe(6e21);
    expect(resolution.ledger.passed).toBe(true);
    expect(resolution.dissipation.heatJoules).toBeGreaterThan(0);
    expect(resolution.approximations).toContain('remnantDensity');
  });

  it('把 hit-and-run 的入射径向速度镜像成分离速度并保持 event-total', () => {
    const baseBodies = contactBodies({
      targetMassKg: 4e24,
      projectileMassKg: 2e24,
      targetRadiusMeters: 7e6,
      projectileRadiusMeters: 5e6,
      impactSpeedMetersPerSecond: 1,
      impactAngleRadians: Math.asin(0.8),
    });
    const escapeSpeed = computeContactQuantities(...baseBodies).mutualEscapeSpeedMetersPerSecond;
    const bodies = contactBodies({
      targetMassKg: 4e24,
      projectileMassKg: 2e24,
      targetRadiusMeters: 7e6,
      projectileRadiusMeters: 5e6,
      impactSpeedMetersPerSecond: 1.5 * escapeSpeed,
      impactAngleRadians: Math.asin(0.8),
    });
    const response = expectSuccess(classicRequest('event-hit-run', bodies));
    const resolution = response.events[0];
    if (resolution?.domain !== 'classic') {
      throw new Error('预期经典碰撞结果');
    }
    expect(resolution.candidate.classification).toBe('hitAndRun');
    expect(resolution.after.majorBodies).toHaveLength(2);
    const target = resolution.after.majorBodies.find((body) => body.id === 'target');
    const projectile = resolution.after.majorBodies.find((body) => body.id === 'projectile');
    if (target === undefined || projectile === undefined) {
      throw new Error('hit-and-run 必须保留两个参与体');
    }
    expect(
      dot(
        subtract(projectile.positionMeters, target.positionMeters),
        subtract(projectile.velocityMetersPerSecond, target.velocityMetersPerSecond),
      ),
    ).toBeGreaterThan(0);
    expect(resolution.ledger.passed).toBe(true);
    expect(resolution.approximations).toContain('separationKinematics');
  });

  it('把灾难性破坏重建成一个 major 和一个有质量 dust cohort', () => {
    const baseBodies = contactBodies({
      targetMassKg: 4e21,
      projectileMassKg: 2e21,
      targetRadiusMeters: 700_000,
      projectileRadiusMeters: 500_000,
      impactSpeedMetersPerSecond: 1,
    });
    const baseContact = computeContactQuantities(...baseBodies);
    const criticalSpeed = computeDisruptionScaling(
      baseContact,
      'gravitySolid',
    ).criticalImpactSpeedMetersPerSecond;
    const bodies = contactBodies({
      targetMassKg: 4e21,
      projectileMassKg: 2e21,
      targetRadiusMeters: 700_000,
      projectileRadiusMeters: 500_000,
      impactSpeedMetersPerSecond: 1.1 * criticalSpeed,
    });
    const response = expectSuccess(classicRequest('event-catastrophic', bodies));
    const resolution = response.events[0];
    if (resolution?.domain !== 'classic') {
      throw new Error('预期经典碰撞结果');
    }
    expect(resolution.candidate.classification).toBe('catastrophicDisruption');
    expect(resolution.after.majorBodies).toHaveLength(1);
    expect(resolution.after.tracers).toHaveLength(0);
    expect(resolution.after.dustCohorts).toHaveLength(1);
    expect(resolution.ledger.passed).toBe(true);
    expect(resolution.dissipation.fractureJoules).toBeGreaterThan(0);
    expect(resolution.approximations).toContain('passiveFragment');
  });

  it('把部分吸积的抛射质量聚合成一个有质量 tracer', () => {
    const baseBodies = contactBodies({
      targetMassKg: 4e21,
      projectileMassKg: 2e21,
      targetRadiusMeters: 700_000,
      projectileRadiusMeters: 500_000,
      impactSpeedMetersPerSecond: 1,
    });
    const criticalSpeed = computeDisruptionScaling(
      computeContactQuantities(...baseBodies),
      'gravitySolid',
    ).criticalImpactSpeedMetersPerSecond;
    const bodies = contactBodies({
      targetMassKg: 4e21,
      projectileMassKg: 2e21,
      targetRadiusMeters: 700_000,
      projectileRadiusMeters: 500_000,
      impactSpeedMetersPerSecond: Math.sqrt(0.2) * criticalSpeed,
    });
    const response = expectSuccess(classicRequest('event-partial', bodies));
    const resolution = response.events[0];
    if (resolution?.domain !== 'classic') {
      throw new Error('预期经典碰撞结果');
    }
    expect(resolution.candidate.classification).toBe('partialAccretion');
    expect(resolution.after.majorBodies).toHaveLength(1);
    expect(resolution.after.tracers).toHaveLength(1);
    expect(resolution.after.dustCohorts).toHaveLength(0);
    expect(resolution.ledger.passed).toBe(true);
  });

  it('用独立 domain 记录黑洞吞噬和被吞材料来源', () => {
    const blackHoleMassKg = 5e24;
    const blackHoleRadiusMeters = 0.01;
    const classicRadiusMeters = 100_000;
    const blackHole: CollisionBodySnapshot = {
      id: 'black-hole',
      massKg: blackHoleMassKg,
      radiusMeters: blackHoleRadiusMeters,
      positionMeters: { x: 0, y: 0, z: 0 },
      velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
      spinAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 1e20 },
      momentOfInertiaFactor: null,
      materialLayers: [],
      collisionModel: 'blackHole',
    };
    const planet: CollisionBodySnapshot = {
      id: 'planet',
      massKg: 1e20,
      radiusMeters: classicRadiusMeters,
      positionMeters: { x: blackHoleRadiusMeters + classicRadiusMeters, y: 0, z: 0 },
      velocityMetersPerSecond: { x: -1_000, y: 100, z: 0 },
      spinAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 0 },
      momentOfInertiaFactor: 0.4,
      materialLayers: [
        { material: 'silicate', massFraction: 0.7 },
        { material: 'iron', massFraction: 0.3 },
      ],
      collisionModel: 'gravitySolid',
    };
    const request: CollisionKernelBatchRequest = {
      abiVersion: COLLISION_KERNEL_ABI_VERSION,
      modelVersion: COLLISION_MODEL_VERSION,
      reconstructionVersion: COLLISION_RECONSTRUCTION_VERSION,
      capacity: { majorRemnantSlots: 1, passiveAssetSlots: 0 },
      events: [
        {
          domain: 'blackHoleAccretion',
          input: {
            eventId: 'event-black-hole',
            simulationTimeSeconds: 7,
            firstBody: blackHole,
            secondBody: planet,
          },
          expectedMaterialProfile: null,
        },
      ],
    };
    const response = expectSuccess(request);
    const resolution = response.events[0];
    if (resolution?.domain !== 'blackHoleAccretion') {
      throw new Error('预期黑洞吞噬结果');
    }
    expect(resolution.remnant.massKg).toBe(blackHoleMassKg + planet.massKg);
    expect(resolution.remnant.collisionModel).toBe('blackHole');
    expect(resolution.ledger.accretedMaterialMassesKg.silicate / planet.massKg).toBeCloseTo(
      0.7,
      12,
    );
    expect(resolution.ledger.accretedMaterialMassesKg.iron / planet.massKg).toBeCloseTo(0.3, 12);
    expect(resolution.ledger.relativeKineticEnergy.radiationJoules).toBeGreaterThan(0);
    expect(resolution.ledger.passed).toBe(true);
  });

  it('按 UTF-8 eventId 稳定排序，输入批次顺序不改变结果', () => {
    const firstBodies = contactBodies({
      targetMassKg: 4e21,
      projectileMassKg: 2e21,
      targetRadiusMeters: 700_000,
      projectileRadiusMeters: 500_000,
      impactSpeedMetersPerSecond: 1,
    });
    const secondBodies = firstBodies.map((body) => ({ ...body, id: `second-${body.id}` })) as [
      CollisionBodySnapshot,
      CollisionBodySnapshot,
    ];
    const firstEvent = classicRequest('z-event', firstBodies).events[0];
    const secondEvent = classicRequest('a-event', secondBodies).events[0];
    if (firstEvent === undefined || secondEvent === undefined) {
      throw new Error('测试事件缺失');
    }
    const base = {
      abiVersion: COLLISION_KERNEL_ABI_VERSION,
      modelVersion: COLLISION_MODEL_VERSION,
      reconstructionVersion: COLLISION_RECONSTRUCTION_VERSION,
      capacity: { majorRemnantSlots: 2, passiveAssetSlots: 0 },
    } as const;
    const forward = expectSuccess({ ...base, events: [firstEvent, secondEvent] });
    const reverse = expectSuccess({ ...base, events: [secondEvent, firstEvent] });
    expect(forward).toEqual(reverse);
    expect(forward.events.map((event) => event.eventId)).toEqual(['a-event', 'z-event']);
  });

  it('交换同一事件的父体输入顺序仍生成完全相同的合并结果', () => {
    const bodies = contactBodies({
      targetMassKg: 4e21,
      projectileMassKg: 2e21,
      targetRadiusMeters: 700_000,
      projectileRadiusMeters: 500_000,
      impactSpeedMetersPerSecond: 1,
    });
    const forward = expectSuccess(classicRequest('event-swap', bodies));
    const reversed = expectSuccess(classicRequest('event-swap', [bodies[1], bodies[0]]));
    expect(reversed).toEqual(forward);
  });

  it('将畸形、共享参与体和容量不足返回为结构化错误 envelope', () => {
    const bodies = contactBodies({
      targetMassKg: 4e21,
      projectileMassKg: 2e21,
      targetRadiusMeters: 700_000,
      projectileRadiusMeters: 500_000,
      impactSpeedMetersPerSecond: 1,
    });
    expect(resolveCollisionKernelReference({ unexpected: true })).toMatchObject({
      kind: 'error',
      error: { code: 'malformedInput', eventId: null },
    });

    const request = classicRequest('event-capacity', bodies, {
      majorRemnantSlots: 0,
      passiveAssetSlots: 0,
    });
    expect(resolveCollisionKernelReference(request)).toMatchObject({
      kind: 'error',
      error: { code: 'collisionCapacityExceeded', eventId: 'event-capacity' },
    });

    const event = request.events[0];
    if (event === undefined) {
      throw new Error('测试事件缺失');
    }
    const sharedRequest = {
      ...request,
      capacity: { majorRemnantSlots: 2, passiveAssetSlots: 0 },
      events: [event, { ...event, input: { ...event.input, eventId: 'event-shared' } }],
    };
    expect(collisionKernelBatchRequestSchema.safeParse(sharedRequest).success).toBe(false);
    expect(resolveCollisionKernelReference(sharedRequest)).toMatchObject({
      kind: 'error',
      error: { code: 'malformedInput' },
    });
  });

  it('成功和错误响应都由严格 schema 接受并拒绝额外字段', () => {
    const bodies = contactBodies({
      targetMassKg: 4e21,
      projectileMassKg: 2e21,
      targetRadiusMeters: 700_000,
      projectileRadiusMeters: 500_000,
      impactSpeedMetersPerSecond: 1,
    });
    const success = resolveCollisionKernelReference(classicRequest('event-schema', bodies));
    const failure = resolveCollisionKernelReference({});
    expect(collisionKernelResponseSchema.safeParse(success).success).toBe(true);
    expect(collisionKernelResponseSchema.safeParse(failure).success).toBe(true);
    expect(collisionKernelResponseSchema.safeParse({ ...failure, unexpected: true }).success).toBe(
      false,
    );
  });
});
