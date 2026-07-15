import { describe, expect, it } from 'vitest';

import { GRAVITATIONAL_CONSTANT_SI } from '../constants';
import { computeContactQuantities } from './contact-quantities';
import {
  classifyCollisionOutcome,
  computeGendaCriticalVelocityRatio,
  computeGendaMergingThreshold,
  computeLargestRemnantMassFraction,
  createCollisionResolutionCandidate,
  createNonInteractingTangentCandidate,
} from './classification';
import {
  computeDisruptionScaling,
  computeEquivalentCombinedRadiusMeters,
} from './disruption-scaling';
import { COLLISION_GOLDEN_FIXTURES } from './golden-fixtures';
import { collisionResolutionCandidateSchema } from './schemas';
import { collisionBody, contactBodies } from './test-helpers';

function expectRelative(actual: number, expected: number, tolerance = 1e-10): void {
  expect(Math.abs(actual - expected) / Math.max(Math.abs(expected), 1)).toBeLessThanOrEqual(
    tolerance,
  );
}

describe('LS2012 接触量', () => {
  it('复现论文表格的 Q_R 样例', () => {
    for (const fixture of COLLISION_GOLDEN_FIXTURES.specificImpactEnergy) {
      const [target, projectile] = contactBodies({
        targetMassKg: fixture.targetMassKg,
        projectileMassKg: fixture.projectileMassKg,
        targetRadiusMeters: 10,
        projectileRadiusMeters: 5,
        impactSpeedMetersPerSecond: fixture.impactSpeedMetersPerSecond,
      });
      const contact = computeContactQuantities(target, projectile);
      expectRelative(contact.specificImpactEnergyJoulesPerKg, fixture.expectedJoulesPerKg, 1e-12);
    }
  });

  it('复现 Eq.11 的交互质量并保持交换对称', () => {
    for (const fixture of COLLISION_GOLDEN_FIXTURES.interactingFraction) {
      const targetRadiusMeters = 1;
      const projectileRadiusMeters = Math.cbrt(fixture.massRatio);
      const [target, projectile] = contactBodies({
        targetMassKg: 1,
        projectileMassKg: fixture.massRatio,
        targetRadiusMeters,
        projectileRadiusMeters,
        impactSpeedMetersPerSecond: 2,
        impactAngleRadians: Math.asin(fixture.impactParameter),
      });
      const forward = computeContactQuantities(target, projectile);
      const reversed = computeContactQuantities(projectile, target);
      expectRelative(forward.interactingProjectileFraction, fixture.expected, 2e-10);
      expect(reversed).toEqual(forward);
    }
  });

  it('在极端质量比下仍返回有限接触量与破坏阈值', () => {
    const [target, projectile] = contactBodies({
      targetMassKg: 1e24,
      projectileMassKg: 1e12,
      targetRadiusMeters: 1e6,
      projectileRadiusMeters: 100,
      impactSpeedMetersPerSecond: 10_000,
    });
    const contact = computeContactQuantities(target, projectile);
    const scaling = computeDisruptionScaling(contact, 'gravitySolid');
    expect(contact.massRatio).toBe(1e-12);
    expect(
      Object.values(contact)
        .filter((value) => typeof value === 'number')
        .every(Number.isFinite),
    ).toBe(true);
    expect(
      Object.values(scaling)
        .filter((value) => typeof value === 'number')
        .every(Number.isFinite),
    ).toBe(true);

    const hugeContact = computeContactQuantities(
      ...contactBodies({
        targetMassKg: 1e200,
        projectileMassKg: 1e200,
        targetRadiusMeters: 1e50,
        projectileRadiusMeters: 1e50,
        impactSpeedMetersPerSecond: 1,
      }),
    );
    expect(hugeContact.reducedMassKg).toBe(5e199);
    expect(hugeContact.specificImpactEnergyJoulesPerKg).toBe(0.125);
    const hugeScaling = computeDisruptionScaling(hugeContact, 'gravitySolid');
    expect(
      [...Object.values(hugeContact), ...Object.values(hugeScaling)]
        .filter((value) => typeof value === 'number')
        .every(Number.isFinite),
    ).toBe(true);

    const nearMaximumContact = computeContactQuantities(
      ...contactBodies({
        targetMassKg: 9e307,
        projectileMassKg: 1e307,
        targetRadiusMeters: 1,
        projectileRadiusMeters: 1,
        impactSpeedMetersPerSecond: 1,
      }),
    );
    expect(nearMaximumContact.totalMassKg).toBe(1e308);
    expect(
      Object.values(computeDisruptionScaling(nearMaximumContact, 'gravitySolid'))
        .filter((value) => typeof value === 'number')
        .every(Number.isFinite),
    ).toBe(true);
    expect(() =>
      computeContactQuantities(
        ...contactBodies({
          targetMassKg: 1e308,
          projectileMassKg: 1e308,
          targetRadiusMeters: 1,
          projectileRadiusMeters: 1,
          impactSpeedMetersPerSecond: 1,
        }),
      ),
    ).toThrow('有限数');

    const largeVectorContact = computeContactQuantities(
      ...contactBodies({
        targetMassKg: 1e100,
        projectileMassKg: 1e100,
        targetRadiusMeters: 5e249,
        projectileRadiusMeters: 5e249,
        impactSpeedMetersPerSecond: 1e100,
        impactAngleRadians: Math.PI / 4,
      }),
    );
    expect(largeVectorContact.impactParameter).toBeCloseTo(Math.SQRT1_2, 12);
    expect(Number.isFinite(largeVectorContact.specificImpactEnergyJoulesPerKg)).toBe(true);
  });

  it('用稳定 id 打破等质量平局，并把 b=bcrit 归为非擦碰', () => {
    const [first, second] = contactBodies({
      targetMassKg: 1,
      projectileMassKg: 1,
      targetRadiusMeters: 1,
      projectileRadiusMeters: 1,
      impactSpeedMetersPerSecond: 2,
      impactAngleRadians: Math.asin(0.5),
    });
    const renamedFirst = { ...first, id: 'z-body' };
    const renamedSecond = { ...second, id: 'a-body' };
    const contact = computeContactQuantities(renamedFirst, renamedSecond);
    expect(contact.targetBodyId).toBe('a-body');
    expect(contact.impactParameter).toBeCloseTo(contact.criticalImpactParameter, 14);
    expect(contact.grazing).toBe(false);
  });

  it('按 UTF-8 字节序处理非 BMP 的等质量平局', () => {
    const [first, second] = contactBodies({
      targetMassKg: 1,
      projectileMassKg: 1,
      targetRadiusMeters: 1,
      projectileRadiusMeters: 1,
      impactSpeedMetersPerSecond: 2,
    });
    const contact = computeContactQuantities(
      { ...first, id: '\u{10000}' },
      { ...second, id: '\uE000' },
    );
    expect(contact.targetBodyId).toBe('\uE000');
    expect(
      computeContactQuantities({ ...second, id: '\uE000' }, { ...first, id: '\u{10000}' }),
    ).toEqual(contact);
  });

  it('等质量异半径优先选择大半径目标体，结果不受 id 影响', () => {
    const [large, small] = contactBodies({
      targetMassKg: 1,
      projectileMassKg: 1,
      targetRadiusMeters: 2,
      projectileRadiusMeters: 1,
      impactSpeedMetersPerSecond: 2,
      impactAngleRadians: Math.asin(0.7),
    });
    const first = computeContactQuantities(
      { ...large, id: 'z-large' },
      { ...small, id: 'a-small' },
    );
    const second = computeContactQuantities(
      { ...large, id: 'a-large' },
      { ...small, id: 'z-small' },
    );
    expect(first.targetRadiusMeters).toBe(2);
    expect(second.targetRadiusMeters).toBe(2);
    expect(first.interactingProjectileFraction).toBeCloseTo(
      second.interactingProjectileFraction,
      14,
    );
  });

  it('拒绝零相对速度、重合中心和正在分离的快照', () => {
    const body = collisionBody({ id: 'a', massKg: 2, radiusMeters: 1 });
    expect(() =>
      computeContactQuantities(body, collisionBody({ id: 'b', massKg: 1, radiusMeters: 1 })),
    ).toThrow('中心距离');
    expect(() =>
      computeContactQuantities(
        body,
        collisionBody({
          id: 'b',
          massKg: 1,
          radiusMeters: 1,
          positionMeters: { x: 2, y: 0, z: 0 },
        }),
      ),
    ).toThrow('相对速度');
    expect(() =>
      computeContactQuantities(
        body,
        collisionBody({
          id: 'b',
          massKg: 1,
          radiusMeters: 1,
          positionMeters: { x: 2, y: 0, z: 0 },
          velocityMetersPerSecond: { x: 1, y: 0, z: 0 },
        }),
      ),
    ).toThrow('开始分离');
    expect(() =>
      computeContactQuantities(
        body,
        collisionBody({
          id: 'b',
          massKg: 1,
          radiusMeters: 1,
          positionMeters: { x: 20, y: 0, z: 0 },
          velocityMetersPerSecond: { x: -1, y: 0, z: 0 },
        }),
      ),
    ).toThrow('尚未接触');
  });
});

describe('LS2012 破坏标度', () => {
  it('复现 Eq.28 主破坏曲线和 Eq.30 临界速度', () => {
    for (const fixture of COLLISION_GOLDEN_FIXTURES.principalDisruption) {
      const totalMassKg = (4 / 3) * Math.PI * 1_000 * fixture.combinedRadiusMeters ** 3;
      const [target, projectile] = contactBodies({
        targetMassKg: totalMassKg / 2,
        projectileMassKg: totalMassKg / 2,
        targetRadiusMeters: 1,
        projectileRadiusMeters: 1,
        impactSpeedMetersPerSecond: 1,
      });
      const scaling = computeDisruptionScaling(
        computeContactQuantities(target, projectile),
        fixture.profile,
      );
      expectRelative(
        computeEquivalentCombinedRadiusMeters(totalMassKg),
        fixture.combinedRadiusMeters,
        1e-12,
      );
      expectRelative(
        scaling.principalDisruptionThresholdJoulesPerKg,
        fixture.expectedThresholdJoulesPerKg,
        1e-12,
      );
      expectRelative(
        scaling.criticalImpactSpeedMetersPerSecond,
        fixture.expectedCriticalSpeedMetersPerSecond,
        1e-12,
      );
    }
  });

  it('复现质量比和斜碰的完整公式链', () => {
    const fixtures = [
      COLLISION_GOLDEN_FIXTURES.fullDisruptionChain,
      COLLISION_GOLDEN_FIXTURES.highInteractionDisruptionChain,
    ];
    for (const fixture of fixtures) {
      const targetMassKg = fixture.totalMassKg / (1 + fixture.massRatio);
      const projectileMassKg = fixture.totalMassKg - targetMassKg;
      const [target, projectile] = contactBodies({
        targetMassKg,
        projectileMassKg,
        targetRadiusMeters: fixture.targetRadiusMeters,
        projectileRadiusMeters: fixture.projectileRadiusMeters,
        impactSpeedMetersPerSecond: 1,
        impactAngleRadians: (fixture.impactAngleDegrees * Math.PI) / 180,
      });
      const contact = computeContactQuantities(target, projectile);
      const scaling = computeDisruptionScaling(contact, 'gravitySolid');
      expectRelative(
        contact.criticalImpactParameter,
        fixture.expectedCriticalImpactParameter,
        3e-12,
      );
      expectRelative(
        contact.interactingProjectileFraction,
        fixture.expectedInteractingFraction,
        2e-12,
      );
      expectRelative(
        contact.reducedMassKg / contact.interactingReducedMassKg,
        fixture.expectedReducedMassRatio,
        2e-12,
      );
      expectRelative(
        scaling.headOnDisruptionThresholdJoulesPerKg,
        fixture.expectedHeadOnThresholdJoulesPerKg,
        2e-12,
      );
      expectRelative(
        scaling.disruptionThresholdJoulesPerKg,
        fixture.expectedObliqueThresholdJoulesPerKg,
        2e-12,
      );
      expectRelative(
        scaling.criticalImpactSpeedMetersPerSecond,
        fixture.expectedCriticalSpeedMetersPerSecond,
        3e-12,
      );
      expect(scaling.obliquityModelExtrapolated).toBe(fixture.expectedInteractingFraction <= 0.5);
    }
    expect(
      COLLISION_GOLDEN_FIXTURES.highInteractionDisruptionChain.expectedInteractingFraction,
    ).toBeGreaterThan(0.5);
  });

  it('在 alpha=0.5 边界及两侧标记 LS2012 斜碰外推', () => {
    const scalingAtImpactParameter = (impactParameter: number) => {
      const contact = computeContactQuantities(
        ...contactBodies({
          targetMassKg: 1e20,
          projectileMassKg: 1e20,
          targetRadiusMeters: 1_000,
          projectileRadiusMeters: 1_000,
          impactSpeedMetersPerSecond: 1,
          impactAngleRadians: Math.asin(impactParameter),
        }),
      );
      return computeDisruptionScaling(contact, 'gravitySolid');
    };

    expect(scalingAtImpactParameter(0.499_999).obliquityModelExtrapolated).toBe(false);
    expect(scalingAtImpactParameter(0.5).obliquityModelExtrapolated).toBe(true);
    expect(scalingAtImpactParameter(0.500_001).obliquityModelExtrapolated).toBe(true);
  });

  it('在纯正切零交互质量时安全拒绝破坏标度', () => {
    const [target, projectile] = contactBodies({
      targetMassKg: 2,
      projectileMassKg: 1,
      targetRadiusMeters: 1,
      projectileRadiusMeters: 1,
      impactSpeedMetersPerSecond: 2,
      impactAngleRadians: Math.PI / 2,
    });
    const contact = computeContactQuantities(target, projectile);
    expect(() => computeDisruptionScaling(contact, 'gravitySolid')).toThrow('零交互质量');
    const candidate = createNonInteractingTangentCandidate(contact);
    expect(candidate).toMatchObject({
      resolutionKind: 'nonInteractingTangent',
      classification: 'hitAndRun',
      disruption: null,
    });
  });
});

describe('最大残体和分类', () => {
  it('复现 universal law 与 super-catastrophic law', () => {
    for (const fixture of COLLISION_GOLDEN_FIXTURES.largestRemnant) {
      expectRelative(
        computeLargestRemnantMassFraction(fixture.normalizedImpactEnergy),
        fixture.expectedFraction,
        2e-12,
      );
    }
  });

  it('复现 Genda Eq.16 拟合值', () => {
    for (const fixture of COLLISION_GOLDEN_FIXTURES.gendaCriticalVelocityRatio) {
      expectRelative(
        computeGendaCriticalVelocityRatio(
          fixture.massRatio,
          Math.sin((fixture.impactAngleDegrees * Math.PI) / 180),
        ),
        fixture.expected,
        2e-12,
      );
    }
    const createGendaContact = (
      massRatio: number,
      impactParameter: number,
      speedEscapeRatio = 1.2,
      totalMassEarthMasses = 1,
    ) => {
      const totalMassKg = 5.9722e24 * totalMassEarthMasses;
      const targetMassKg = totalMassKg / (1 + massRatio);
      const projectileMassKg = totalMassKg - targetMassKg;
      const targetRadiusMeters = 6e6;
      const projectileRadiusMeters = targetRadiusMeters * Math.cbrt(massRatio);
      const initial = computeContactQuantities(
        ...contactBodies({
          targetMassKg,
          projectileMassKg,
          targetRadiusMeters,
          projectileRadiusMeters,
          impactSpeedMetersPerSecond: 1,
          impactAngleRadians: Math.asin(impactParameter),
        }),
      );
      return computeContactQuantities(
        ...contactBodies({
          targetMassKg,
          projectileMassKg,
          targetRadiusMeters,
          projectileRadiusMeters,
          impactSpeedMetersPerSecond: speedEscapeRatio * initial.mutualEscapeSpeedMetersPerSecond,
          impactAngleRadians: Math.asin(impactParameter),
        }),
      );
    };
    expect(computeGendaMergingThreshold(createGendaContact(0.1, 0.5)).modelExtrapolated).toBe(true);
    expect(
      computeGendaMergingThreshold(createGendaContact(1, Math.sin((76 * Math.PI) / 180)))
        .modelExtrapolated,
    ).toBe(true);
    expect(computeGendaMergingThreshold(createGendaContact(0.25, 0.5)).modelExtrapolated).toBe(
      false,
    );
    expect(
      computeGendaMergingThreshold(createGendaContact(0.25, 0.5, 3.01)).modelExtrapolated,
    ).toBe(true);
    expect(
      computeGendaMergingThreshold(createGendaContact(0.25, 0.5, 1.2, 0.19)).modelExtrapolated,
    ).toBe(true);
  });

  it('覆盖合并、擦碰分离、部分吸积、侵蚀和两级碎裂边界', () => {
    const escapeSpeed = Math.sqrt((2 * GRAVITATIONAL_CONSTANT_SI * 5) / 1.5);
    const createContact = (speedRatio: number, impactParameter: number) =>
      computeContactQuantities(
        ...contactBodies({
          targetMassKg: 4,
          projectileMassKg: 1,
          targetRadiusMeters: 1,
          projectileRadiusMeters: 0.5,
          impactSpeedMetersPerSecond: speedRatio * escapeSpeed,
          impactAngleRadians: Math.asin(impactParameter),
        }),
      );
    const candidate = (
      normalizedImpactEnergy: number,
      speedRatio: number,
      gendaRatio: number | null,
    ) =>
      classifyCollisionOutcome(
        createContact(speedRatio, 0.9),
        normalizedImpactEnergy,
        gendaRatio === null
          ? null
          : { criticalVelocityRatio: gendaRatio, modelExtrapolated: false },
      );

    expect(candidate(0.2, 1, 1.5)).toBe('merge');
    expect(candidate(0.2, 1.4, 1.5)).toBe('grazeAndMerge');
    expect(candidate(0.2, 1.6, 1.5)).toBe('hitAndRun');
    expect(() => candidate(0.2, 1.6, null)).toThrow('必须提供');

    const classifyNonGrazing = (normalizedImpactEnergy: number) =>
      classifyCollisionOutcome(createContact(1.6, 0), normalizedImpactEnergy, null);
    expect(classifyNonGrazing(0.2)).toBe('partialAccretion');
    expect(classifyNonGrazing(0.6)).toBe('erosion');
    expect(classifyNonGrazing(1)).toBe('catastrophicDisruption');
    expect(classifyNonGrazing(1.8)).toBe('catastrophicDisruption');
    expect(classifyNonGrazing(1.800_001)).toBe('superCatastrophicDisruption');
  });

  it('锁定破坏边界两侧与 Genda 等号语义', () => {
    const escapeSpeed = Math.sqrt(2 * GRAVITATIONAL_CONSTANT_SI);
    const createContact = (speedRatio: number) =>
      computeContactQuantities(
        ...contactBodies({
          targetMassKg: 1,
          projectileMassKg: 1,
          targetRadiusMeters: 1,
          projectileRadiusMeters: 1,
          impactSpeedMetersPerSecond: speedRatio * escapeSpeed,
          impactAngleRadians: Math.asin(0.8),
        }),
      );
    const classify = (normalizedImpactEnergy: number, speed = 1.5) =>
      classifyCollisionOutcome(createContact(speed), normalizedImpactEnergy, {
        criticalVelocityRatio: 1.5,
        modelExtrapolated: false,
      });

    expect(classify(0.99)).toBe('grazeAndMerge');
    expect(classify(1)).toBe('catastrophicDisruption');
    expect(classify(1.01)).toBe('catastrophicDisruption');
    expect(classify(1.8 * 0.99)).toBe('catastrophicDisruption');
    expect(classify(1.8)).toBe('catastrophicDisruption');
    expect(classify(1.8 * 1.01)).toBe('superCatastrophicDisruption');
    expect(classify(0.5, 1.5)).toBe('grazeAndMerge');
    expect(classify(0.5, 1.500_001)).toBe('hitAndRun');
  });

  it('拒绝 Rust 候选篡改分类、最大残体、Genda 临界线或派生标度', () => {
    const totalMassKg = COLLISION_GOLDEN_FIXTURES.fullDisruptionChain.totalMassKg;
    const createContactAt = (impactSpeedMetersPerSecond: number, impactParameter: number) =>
      computeContactQuantities(
        ...contactBodies({
          targetMassKg: totalMassKg / 2,
          projectileMassKg: totalMassKg / 2,
          targetRadiusMeters: 800_000,
          projectileRadiusMeters: 800_000,
          impactSpeedMetersPerSecond,
          impactAngleRadians: Math.asin(impactParameter),
        }),
      );
    const createCandidateAtEnergy = (normalizedImpactEnergy: number, impactParameter: number) => {
      const initialContact = createContactAt(1, impactParameter);
      const initialScaling = computeDisruptionScaling(initialContact, 'gravitySolid');
      const contact = createContactAt(
        Math.sqrt(normalizedImpactEnergy) * initialScaling.criticalImpactSpeedMetersPerSecond,
        impactParameter,
      );
      const disruption = computeDisruptionScaling(contact, 'gravitySolid');
      const genda = contact.grazing ? computeGendaMergingThreshold(contact) : null;
      return createCollisionResolutionCandidate(contact, disruption, genda);
    };

    const candidate = createCandidateAtEnergy(0.2, 0);
    expect(candidate.classification).toBe('partialAccretion');
    const disruption = candidate.disruption;
    if (disruption === null) {
      throw new Error('测试候选缺少破坏标度');
    }
    expect(
      collisionResolutionCandidateSchema.safeParse({
        ...candidate,
        classification: 'erosion',
      }).success,
    ).toBe(false);
    expect(
      collisionResolutionCandidateSchema.safeParse({
        ...candidate,
        largestRemnantMassFraction: 0.8,
        largestRemnantMassKg: 0.8 * candidate.contact.totalMassKg,
      }).success,
    ).toBe(false);

    const numericDisruptionFields = [
      'equivalentCombinedRadiusMeters',
      'principalDisruptionThresholdJoulesPerKg',
      'massRatioScale',
      'headOnDisruptionThresholdJoulesPerKg',
      'obliquityScale',
      'disruptionThresholdJoulesPerKg',
      'criticalImpactSpeedMetersPerSecond',
      'normalizedImpactEnergy',
    ] as const;
    for (const field of numericDisruptionFields) {
      expect(
        collisionResolutionCandidateSchema.safeParse({
          ...candidate,
          disruption: { ...disruption, [field]: disruption[field] * 1.01 },
        }).success,
      ).toBe(false);
    }
    expect(
      collisionResolutionCandidateSchema.safeParse({
        ...candidate,
        disruption: {
          ...disruption,
          obliquityModelExtrapolated: !disruption.obliquityModelExtrapolated,
        },
      }).success,
    ).toBe(false);
    expect(
      collisionResolutionCandidateSchema.safeParse({
        ...candidate,
        disruption: {
          ...disruption,
          disruptionThresholdJoulesPerKg: disruption.disruptionThresholdJoulesPerKg * 1.01,
          criticalImpactSpeedMetersPerSecond:
            disruption.criticalImpactSpeedMetersPerSecond * Math.sqrt(1.01),
          normalizedImpactEnergy: disruption.normalizedImpactEnergy / 1.01,
        },
      }).success,
    ).toBe(false);

    const grazingCandidate = createCandidateAtEnergy(0.2, 0.8);
    const grazingGendaRatio = grazingCandidate.gendaCriticalVelocityRatio;
    if (grazingGendaRatio === null) {
      throw new Error('测试擦碰候选缺少 Genda 临界线');
    }
    expect(
      collisionResolutionCandidateSchema.safeParse({
        ...grazingCandidate,
        gendaCriticalVelocityRatio: grazingGendaRatio * 1.01,
      }).success,
    ).toBe(false);
    expect(
      collisionResolutionCandidateSchema.safeParse({
        ...candidate,
        gendaCriticalVelocityRatio: 1.5,
        gendaModelExtrapolated: false,
      }).success,
    ).toBe(false);

    const extrapolatedCandidate = createCandidateAtEnergy(0.2, Math.sin((76 * Math.PI) / 180));
    expect(extrapolatedCandidate.gendaModelExtrapolated).toBe(true);
    expect(
      collisionResolutionCandidateSchema.safeParse({
        ...extrapolatedCandidate,
        gendaModelExtrapolated: false,
      }).success,
    ).toBe(false);

    const nearCatastrophic = createCandidateAtEnergy(1 - 2e-11, 0);
    const nearCatastrophicFraction = computeLargestRemnantMassFraction(1 + 2e-11);
    expect(nearCatastrophic.classification).toBe('partialAccretion');
    expect(
      collisionResolutionCandidateSchema.safeParse({
        ...nearCatastrophic,
        classification: 'catastrophicDisruption',
        disruption: { ...nearCatastrophic.disruption, normalizedImpactEnergy: 1 + 2e-11 },
        largestRemnantMassFraction: nearCatastrophicFraction,
        largestRemnantMassKg: nearCatastrophicFraction * nearCatastrophic.contact.totalMassKg,
      }).success,
    ).toBe(false);

    const nearSuperCatastrophic = createCandidateAtEnergy(1.8 - 2e-11, 0);
    const nearSuperFraction = computeLargestRemnantMassFraction(1.8 + 2e-11);
    expect(nearSuperCatastrophic.classification).toBe('catastrophicDisruption');
    expect(
      collisionResolutionCandidateSchema.safeParse({
        ...nearSuperCatastrophic,
        classification: 'superCatastrophicDisruption',
        disruption: {
          ...nearSuperCatastrophic.disruption,
          normalizedImpactEnergy: 1.8 + 2e-11,
        },
        largestRemnantMassFraction: nearSuperFraction,
        largestRemnantMassKg: nearSuperFraction * nearSuperCatastrophic.contact.totalMassKg,
      }).success,
    ).toBe(false);

    const boundarySeed = createContactAt(1, 0.8);
    const boundaryThreshold = computeGendaMergingThreshold(boundarySeed);
    const boundaryContact = createContactAt(
      boundaryThreshold.criticalVelocityRatio *
        (1 - 2e-11) *
        boundarySeed.mutualEscapeSpeedMetersPerSecond,
      0.8,
    );
    const boundaryCandidate = createCollisionResolutionCandidate(
      boundaryContact,
      computeDisruptionScaling(boundaryContact, 'gravitySolid'),
      boundaryThreshold,
    );
    expect(boundaryCandidate.classification).toBe('grazeAndMerge');
    expect(
      collisionResolutionCandidateSchema.safeParse({
        ...boundaryCandidate,
        classification: 'hitAndRun',
        largestRemnantMassFraction: null,
        largestRemnantMassKg: null,
        gendaCriticalVelocityRatio: boundaryThreshold.criticalVelocityRatio * (1 - 4e-11),
      }).success,
    ).toBe(false);

    const tangentContact = computeContactQuantities(
      ...contactBodies({
        targetMassKg: 2,
        projectileMassKg: 1,
        targetRadiusMeters: 1,
        projectileRadiusMeters: 1,
        impactSpeedMetersPerSecond: 2,
        impactAngleRadians: Math.PI / 2,
      }),
    );
    const tangentCandidate = createNonInteractingTangentCandidate(tangentContact);
    expect(
      collisionResolutionCandidateSchema.safeParse({
        ...tangentCandidate,
        resolutionKind: 'modeledCollision',
        classification: candidate.classification,
        disruption,
        largestRemnantMassFraction: candidate.largestRemnantMassFraction,
        largestRemnantMassKg: candidate.largestRemnantMassKg,
      }).success,
    ).toBe(false);
  });
});
