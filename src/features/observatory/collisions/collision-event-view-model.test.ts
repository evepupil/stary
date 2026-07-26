import { describe, expect, it } from 'vitest';

import { GRAVITATIONAL_CONSTANT_SI } from '../../../physics/constants';
import {
  BLACK_HOLE_ACCRETION_LEDGER_VERSION,
  COLLISION_MODEL_VERSION,
  COLLISION_RECONSTRUCTION_VERSION,
} from '../../../physics/collisions';
import type { CollisionEvent } from '../../../physics/protocol/schemas';
import { createTestBody, createTestCollisionBatchMessage } from '../simulation/test-helpers';
import type { CollisionLedgerDelta } from '../simulation/simulation-state';
import {
  createCollisionEventViewModel,
  deriveImpactSpeedMetersPerSecond,
  deriveMutualEscapeSpeedMetersPerSecond,
  findLedgerForEvent,
} from './collision-event-view-model';

const firstParent = createTestBody({
  id: 'first-parent',
  massKg: 6e24,
  radiusMeters: 6.4e6,
});
const secondParent = createTestBody({
  id: 'second-parent',
  massKg: 3e24,
  radiusMeters: 4.8e6,
});

function createTestEvent(overrides: Partial<CollisionEvent> = {}): CollisionEvent {
  return {
    eventId: 'collision-event-1',
    modelVersion: COLLISION_MODEL_VERSION,
    participantBodyIds: ['first-parent', 'second-parent'],
    classification: 'merge',
    specificImpactEnergyJoulesPerKg: 0,
    disruptionThresholdJoulesPerKg: 1,
    normalizedImpactEnergy: 0,
    impactAngleRadians: 0,
    modelExtrapolated: false,
    majorRemnantIds: ['major-00ff12ab34cd56ef'],
    tracerIds: [],
    dustCohortIds: [],
    ...overrides,
  };
}

describe('deriveImpactSpeedMetersPerSecond', () => {
  it('从 Q_R 与碰前质量精确反推接触速度', () => {
    const impactSpeed = 12_000;
    const totalMassKg = firstParent.massKg + secondParent.massKg;
    const reducedMassKg = (firstParent.massKg * secondParent.massKg) / totalMassKg;
    const specificImpactEnergyJoulesPerKg = (0.5 * reducedMassKg * impactSpeed ** 2) / totalMassKg;
    const event = createTestEvent({ specificImpactEnergyJoulesPerKg });

    const derived = deriveImpactSpeedMetersPerSecond(event, [firstParent, secondParent]);

    expect(derived).not.toBeNull();
    expect(derived).toBeCloseTo(impactSpeed, 6);
  });

  it('参与体快照缺失时返回 null 而不是猜测', () => {
    const event = createTestEvent();
    expect(deriveImpactSpeedMetersPerSecond(event, [firstParent])).toBeNull();
    expect(deriveImpactSpeedMetersPerSecond(event, [])).toBeNull();
  });
});

describe('deriveMutualEscapeSpeedMetersPerSecond', () => {
  it('用总质量与半径和计算互逃逸速度', () => {
    const expected = Math.sqrt(
      (2 * GRAVITATIONAL_CONSTANT_SI * (firstParent.massKg + secondParent.massKg)) /
        (firstParent.radiusMeters + secondParent.radiusMeters),
    );
    expect(
      deriveMutualEscapeSpeedMetersPerSecond(createTestEvent(), [firstParent, secondParent]),
    ).toBeCloseTo(expected, 9);
  });

  it('零半径点质量返回 null', () => {
    const pointFirst = createTestBody({ id: 'first-parent', massKg: 1, radiusMeters: 0 });
    const pointSecond = createTestBody({ id: 'second-parent', massKg: 1, radiusMeters: 0 });
    expect(
      deriveMutualEscapeSpeedMetersPerSecond(createTestEvent(), [pointFirst, pointSecond]),
    ).toBeNull();
  });
});

describe('createCollisionEventViewModel', () => {
  it('生成分类中文标签、参与体名称与产物摘要', () => {
    const batch = createTestCollisionBatchMessage();
    const event = batch.events.at(0);
    if (event === undefined) {
      throw new Error('测试夹具缺少碰撞事件');
    }
    const viewModel = createCollisionEventViewModel({
      event,
      ledger: findLedgerForEvent(event, batch.ledgerDelta),
      participants: [firstParent, secondParent],
      state: batch.state,
    });

    expect(viewModel.classificationLabel).toBe('合并');
    expect(viewModel.classificationDetailLabel).toBe('完全合并');
    expect(viewModel.participantNames).toEqual(['first-parent', 'second-parent']);
    expect(viewModel.remnants).toHaveLength(1);
    expect(viewModel.remnants[0]).toMatchObject({
      id: 'collision-remnant',
      isSurvivor: false,
    });
    expect(viewModel.ledgerPassed).toBe(true);
    expect(viewModel.conservationChecks.map((check) => check.label)).toEqual([
      '质量',
      '材料质量',
      '线动量',
      '角动量',
      '能量',
    ]);
    expect(viewModel.conservationChecks.every((check) => check.passed)).toBe(true);
    expect(viewModel.matterFate.map((entry) => entry.label)).toContain('碰后主要残体');
    expect(viewModel.dissipation).toHaveLength(4);
  });

  it('太阳系与碰撞残体 id 解析为目录名称，擦碰幸存体标记幸存', () => {
    const survivorEvent = createTestEvent({
      classification: 'hitAndRun',
      participantBodyIds: ['earth', 'major-00ff12ab34cd56ef'],
      majorRemnantIds: ['earth', 'major-00ff12ab34cd56ef'],
      disruptionThresholdJoulesPerKg: null,
      normalizedImpactEnergy: null,
    });
    const viewModel = createCollisionEventViewModel({
      event: survivorEvent,
      ledger: null,
      participants: [],
      state: null,
    });

    expect(viewModel.classificationLabel).toBe('擦碰');
    expect(viewModel.participantNames).toEqual(['地球', '碰撞残体 00ff12']);
    expect(viewModel.remnants.every((remnant) => remnant.isSurvivor)).toBe(true);
    expect(viewModel.contactMeasurements.map((entry) => entry.label)).not.toContain('破坏阈值 Q*');
    expect(viewModel.ledgerPassed).toBeNull();
  });

  it('黑洞吞噬账本给出材料来源、辐射能量与四项守恒校验', () => {
    const conservationCheck = {
      absoluteError: 0,
      scale: 1,
      normalizedError: 0,
      threshold: 1e-10,
      passed: true,
    } as const;
    const blackHoleLedger: CollisionLedgerDelta = {
      ledgerVersion: BLACK_HOLE_ACCRETION_LEDGER_VERSION,
      modelVersion: COLLISION_MODEL_VERSION,
      reconstructionVersion: COLLISION_RECONSTRUCTION_VERSION,
      eventId: 'collision-event-1',
      simulationTimeSeconds: 2,
      referenceFrame: {
        originMeters: { x: 0, y: 0, z: 0 },
        velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
      },
      energyScope: 'relativeKineticOnly',
      mass: { beforeKg: 4, afterKg: 4, check: conservationCheck },
      linearMomentum: {
        beforeKgMetersPerSecond: { x: 0, y: 0, z: 0 },
        afterKgMetersPerSecond: { x: 0, y: 0, z: 0 },
        check: conservationCheck,
      },
      angularMomentum: {
        beforeKgMetersSquaredPerSecond: { x: 0, y: 0, z: 0 },
        afterKgMetersSquaredPerSecond: { x: 0, y: 0, z: 0 },
        check: conservationCheck,
      },
      relativeKineticEnergy: {
        beforeJoules: 5,
        afterJoules: 0,
        radiationJoules: 5,
        check: conservationCheck,
      },
      accretedMaterialMassesKg: { gas: 0, ice: 0, silicate: 1, iron: 0.5 },
      limits: { mass: 1e-12, linearMomentum: 1e-10, angularMomentum: 1e-8, energy: 1e-6 },
      passed: true,
    };
    const event = createTestEvent({
      classification: 'blackHoleAccretion',
      disruptionThresholdJoulesPerKg: null,
      normalizedImpactEnergy: null,
      modelExtrapolated: true,
    });

    const viewModel = createCollisionEventViewModel({
      event,
      ledger: blackHoleLedger,
      participants: [firstParent, secondParent],
      state: null,
    });

    expect(viewModel.classificationLabel).toBe('黑洞吞噬');
    expect(viewModel.modelExtrapolated).toBe(true);
    expect(viewModel.matterFate.map((entry) => entry.label)).toEqual([
      '吞噬前总质量',
      '黑洞残体质量',
      '被吞硅酸盐',
      '被吞铁',
      '辐射能量',
    ]);
    expect(viewModel.conservationChecks).toHaveLength(4);
    expect(viewModel.dissipation).toEqual([{ label: '辐射', value: '5.000e+0 J' }]);
  });
});
