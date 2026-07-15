import { z } from 'zod';

import { GRAVITATIONAL_CONSTANT_SI } from '../constants';
import {
  COLLISION_LEDGER_VERSION,
  COLLISION_MODEL_VERSION,
  MATERIAL_FRACTION_TOLERANCE,
  MAX_COLLISION_MAJOR_BODIES,
  MAX_COLLISION_PASSIVE_ASSETS,
} from './model-sources';
import {
  computeDisruptionFormula,
  computeGendaCriticalVelocityRatioFormula,
  computeLargestRemnantMassFractionFormula,
  evaluateCollisionClassification,
  isGendaNumericExtrapolation,
} from './collision-formulas';
import { compareUtf8 } from './stable-order';

const finiteNumberSchema = z.number();
const nonNegativeFiniteNumberSchema = finiteNumberSchema.nonnegative();
const positiveFiniteNumberSchema = finiteNumberSchema.positive();
function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0, '标识不能为空白')
  .refine(isWellFormedUnicode, '标识必须是完整 Unicode 字符串');

function approximatelyEqual(actual: number, expected: number, tolerance = 1e-10): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
    return false;
  }
  return (
    Math.abs(actual - expected) <=
    tolerance * Math.max(Math.abs(actual), Math.abs(expected), Number.MIN_VALUE)
  );
}

function addConsistencyIssue(
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: 'custom', message, path: [...path] });
}

export const collisionVectorSchema = z.strictObject({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  z: finiteNumberSchema,
});

export const collisionMaterialSchema = z.enum(['gas', 'ice', 'silicate', 'iron']);
export const collisionModelSchema = z.enum([
  'gravitySolid',
  'gravityFluid',
  'stellar',
  'blackHole',
]);

export const materialLayerSchema = z.strictObject({
  material: collisionMaterialSchema,
  massFraction: positiveFiniteNumberSchema.max(1),
});

const MATERIAL_ORDER: Readonly<Record<CollisionMaterial, number>> = {
  gas: 0,
  ice: 1,
  silicate: 2,
  iron: 3,
};

export const materialLayersSchema = z
  .array(materialLayerSchema)
  .max(4)
  .superRefine((layers, context) => {
    let previousOrder = -1;
    let prefixFraction = 0;
    let totalFraction = 0;

    layers.forEach((layer, index) => {
      const order = MATERIAL_ORDER[layer.material];
      if (order <= previousOrder) {
        context.addIssue({
          code: 'custom',
          message: '材料层必须按 gas、ice、silicate、iron 从外到内排列且不能重复',
          path: [index, 'material'],
        });
      }
      previousOrder = order;
      if (index < layers.length - 1) {
        prefixFraction += layer.massFraction;
        if (prefixFraction >= 1) {
          context.addIssue({
            code: 'custom',
            message: '最后一层之前的材料质量分数之和必须小于 1',
            path: [index, 'massFraction'],
          });
        }
      }
      totalFraction += layer.massFraction;
    });

    if (layers.length > 0 && Math.abs(totalFraction - 1) > MATERIAL_FRACTION_TOLERANCE) {
      context.addIssue({
        code: 'custom',
        message: '材料层质量分数之和必须等于 1',
      });
    }
  });

export const collisionBodySnapshotSchema = z
  .strictObject({
    id: identifierSchema,
    massKg: positiveFiniteNumberSchema,
    radiusMeters: positiveFiniteNumberSchema,
    positionMeters: collisionVectorSchema,
    velocityMetersPerSecond: collisionVectorSchema,
    spinAngularMomentumKgMetersSquaredPerSecond: collisionVectorSchema,
    momentOfInertiaFactor: positiveFiniteNumberSchema.max(0.4).nullable(),
    materialLayers: materialLayersSchema,
    collisionModel: collisionModelSchema,
  })
  .superRefine((body, context) => {
    if (body.collisionModel === 'blackHole') {
      if (body.materialLayers.length !== 0) {
        context.addIssue({
          code: 'custom',
          message: '黑洞不能使用经典材料层',
          path: ['materialLayers'],
        });
      }
      if (body.momentOfInertiaFactor !== null) {
        context.addIssue({
          code: 'custom',
          message: '黑洞不能使用经典转动惯量因子',
          path: ['momentOfInertiaFactor'],
        });
      }
      return;
    }

    if (body.materialLayers.length === 0) {
      context.addIssue({
        code: 'custom',
        message: '经典天体至少需要一个材料层',
        path: ['materialLayers'],
      });
    }
    if (body.momentOfInertiaFactor === null) {
      context.addIssue({
        code: 'custom',
        message: '经典天体必须提供转动惯量因子',
        path: ['momentOfInertiaFactor'],
      });
    }
  });

export const collisionInputSchema = z.strictObject({
  eventId: identifierSchema,
  simulationTimeSeconds: nonNegativeFiniteNumberSchema,
  firstBody: collisionBodySnapshotSchema,
  secondBody: collisionBodySnapshotSchema,
});

export const contactQuantitiesSchema = z
  .strictObject({
    targetBodyId: identifierSchema,
    projectileBodyId: identifierSchema,
    targetMassKg: positiveFiniteNumberSchema,
    projectileMassKg: positiveFiniteNumberSchema,
    targetRadiusMeters: positiveFiniteNumberSchema,
    projectileRadiusMeters: positiveFiniteNumberSchema,
    totalMassKg: positiveFiniteNumberSchema,
    reducedMassKg: positiveFiniteNumberSchema,
    interactingReducedMassKg: nonNegativeFiniteNumberSchema,
    massRatio: positiveFiniteNumberSchema.max(1),
    centerDistanceMeters: positiveFiniteNumberSchema,
    radiusSumMeters: positiveFiniteNumberSchema,
    impactSpeedMetersPerSecond: positiveFiniteNumberSchema,
    mutualEscapeSpeedMetersPerSecond: positiveFiniteNumberSchema,
    specificImpactEnergyJoulesPerKg: nonNegativeFiniteNumberSchema,
    impactAngleRadians: nonNegativeFiniteNumberSchema.max(Math.PI / 2),
    impactParameter: nonNegativeFiniteNumberSchema.max(1),
    criticalImpactParameter: positiveFiniteNumberSchema.max(1),
    interactingLengthMeters: nonNegativeFiniteNumberSchema,
    interactingProjectileFraction: nonNegativeFiniteNumberSchema.max(1),
    grazing: z.boolean(),
  })
  .superRefine((contact, context) => {
    if (contact.targetBodyId === contact.projectileBodyId) {
      addConsistencyIssue(context, ['projectileBodyId'], '目标体和投射体 id 不能相同');
    }
    if (contact.targetMassKg < contact.projectileMassKg) {
      addConsistencyIssue(context, ['targetMassKg'], '目标体质量不能小于投射体');
    }
    if (
      contact.targetMassKg === contact.projectileMassKg &&
      (contact.targetRadiusMeters < contact.projectileRadiusMeters ||
        (contact.targetRadiusMeters === contact.projectileRadiusMeters &&
          compareUtf8(contact.targetBodyId, contact.projectileBodyId) >= 0))
    ) {
      addConsistencyIssue(context, ['targetBodyId'], '等质量天体未使用规范目标体顺序');
    }
    const totalMassKg = contact.targetMassKg + contact.projectileMassKg;
    const reducedMassKg =
      contact.projectileMassKg / (1 + contact.projectileMassKg / contact.targetMassKg);
    const radiusSumMeters = contact.targetRadiusMeters + contact.projectileRadiusMeters;
    const massRatio = contact.projectileMassKg / contact.targetMassKg;
    const criticalImpactParameter = contact.targetRadiusMeters / radiusSumMeters;
    const interactingLengthMeters = Math.min(
      2 * contact.projectileRadiusMeters,
      Math.max(0, radiusSumMeters * (1 - contact.impactParameter)),
    );
    const interactingLengthRadiusRatio = interactingLengthMeters / contact.projectileRadiusMeters;
    const interactingProjectileFraction = Math.min(
      1,
      Math.max(
        0,
        interactingLengthMeters >= 2 * contact.projectileRadiusMeters
          ? 1
          : (3 * interactingLengthRadiusRatio ** 2 - interactingLengthRadiusRatio ** 3) / 4,
      ),
    );
    const interactingMassKg = interactingProjectileFraction * contact.projectileMassKg;
    const interactingReducedMassKg =
      interactingMassKg > 0
        ? interactingMassKg / (1 + interactingMassKg / contact.targetMassKg)
        : 0;
    const mutualEscapeSpeedMetersPerSecond = Math.sqrt(
      (2 * GRAVITATIONAL_CONSTANT_SI * totalMassKg) / radiusSumMeters,
    );
    const specificImpactEnergyJoulesPerKg =
      0.5 * (reducedMassKg / totalMassKg) * contact.impactSpeedMetersPerSecond ** 2;
    const checks = [
      ['totalMassKg', contact.totalMassKg, totalMassKg],
      ['reducedMassKg', contact.reducedMassKg, reducedMassKg],
      ['massRatio', contact.massRatio, massRatio],
      ['radiusSumMeters', contact.radiusSumMeters, radiusSumMeters],
      ['criticalImpactParameter', contact.criticalImpactParameter, criticalImpactParameter],
      ['interactingLengthMeters', contact.interactingLengthMeters, interactingLengthMeters],
      [
        'interactingProjectileFraction',
        contact.interactingProjectileFraction,
        interactingProjectileFraction,
      ],
      ['interactingReducedMassKg', contact.interactingReducedMassKg, interactingReducedMassKg],
      [
        'mutualEscapeSpeedMetersPerSecond',
        contact.mutualEscapeSpeedMetersPerSecond,
        mutualEscapeSpeedMetersPerSecond,
      ],
      [
        'specificImpactEnergyJoulesPerKg',
        contact.specificImpactEnergyJoulesPerKg,
        specificImpactEnergyJoulesPerKg,
      ],
      ['impactParameter', contact.impactParameter, Math.sin(contact.impactAngleRadians)],
    ] as const;
    for (const [path, actual, expected] of checks) {
      if (!approximatelyEqual(actual, expected)) {
        addConsistencyIssue(context, [path], `${path} 与碰撞输入不一致`);
      }
    }
    if (contact.grazing !== contact.impactParameter > contact.criticalImpactParameter) {
      addConsistencyIssue(context, ['grazing'], 'grazing 与撞击参数不一致');
    }
  });

export const disruptionScalingSchema = z.strictObject({
  materialProfile: z.enum(['gravitySolid', 'gravityFluid']),
  equivalentCombinedRadiusMeters: positiveFiniteNumberSchema,
  principalDisruptionThresholdJoulesPerKg: positiveFiniteNumberSchema,
  massRatioScale: positiveFiniteNumberSchema,
  headOnDisruptionThresholdJoulesPerKg: positiveFiniteNumberSchema,
  obliquityScale: positiveFiniteNumberSchema,
  obliquityModelExtrapolated: z.boolean(),
  disruptionThresholdJoulesPerKg: positiveFiniteNumberSchema,
  criticalImpactSpeedMetersPerSecond: positiveFiniteNumberSchema,
  normalizedImpactEnergy: nonNegativeFiniteNumberSchema,
});

export const collisionClassificationSchema = z.enum([
  'merge',
  'grazeAndMerge',
  'hitAndRun',
  'partialAccretion',
  'erosion',
  'catastrophicDisruption',
  'superCatastrophicDisruption',
]);

export const collisionResolutionCandidateSchema = z
  .strictObject({
    modelVersion: z.literal(COLLISION_MODEL_VERSION),
    resolutionKind: z.enum(['modeledCollision', 'nonInteractingTangent']),
    classification: collisionClassificationSchema,
    contact: contactQuantitiesSchema,
    disruption: disruptionScalingSchema.nullable(),
    largestRemnantMassFraction: nonNegativeFiniteNumberSchema.max(1).nullable(),
    largestRemnantMassKg: nonNegativeFiniteNumberSchema.nullable(),
    gendaCriticalVelocityRatio: positiveFiniteNumberSchema.nullable(),
    gendaModelExtrapolated: z.boolean().nullable(),
  })
  .superRefine((candidate, context) => {
    if (candidate.resolutionKind === 'nonInteractingTangent') {
      if (
        candidate.classification !== 'hitAndRun' ||
        candidate.disruption !== null ||
        candidate.gendaCriticalVelocityRatio !== null ||
        candidate.gendaModelExtrapolated !== null ||
        candidate.contact.interactingProjectileFraction !== 0 ||
        candidate.contact.interactingLengthMeters !== 0 ||
        candidate.contact.interactingReducedMassKg !== 0 ||
        !approximatelyEqual(candidate.contact.impactParameter, 1)
      ) {
        addConsistencyIssue(context, ['resolutionKind'], '无相互作用正切候选字段不一致');
      }
      const expectedFraction = candidate.contact.targetMassKg / candidate.contact.totalMassKg;
      if (
        candidate.largestRemnantMassFraction === null ||
        !approximatelyEqual(candidate.largestRemnantMassFraction, expectedFraction) ||
        candidate.largestRemnantMassKg === null ||
        !approximatelyEqual(candidate.largestRemnantMassKg, candidate.contact.targetMassKg)
      ) {
        addConsistencyIssue(context, ['largestRemnantMassKg'], '正切最大残体必须保持原目标体');
      }
      return;
    }

    if (
      candidate.contact.interactingProjectileFraction <= 0 ||
      candidate.contact.interactingReducedMassKg <= 0
    ) {
      addConsistencyIssue(context, ['contact'], '正式碰撞候选必须包含正的交互质量');
    }

    const disruption = candidate.disruption;
    if (disruption === null) {
      addConsistencyIssue(context, ['disruption'], '正式碰撞候选必须包含破坏标度');
      return;
    }
    if (
      (candidate.gendaCriticalVelocityRatio === null) !==
      (candidate.gendaModelExtrapolated === null)
    ) {
      addConsistencyIssue(
        context,
        ['gendaModelExtrapolated'],
        'Genda 临界值与外推标记必须同时存在',
      );
    }
    const trustedTotalMassKg = candidate.contact.targetMassKg + candidate.contact.projectileMassKg;
    const trustedReducedMassKg =
      candidate.contact.projectileMassKg /
      (1 + candidate.contact.projectileMassKg / candidate.contact.targetMassKg);
    const trustedMassRatio = candidate.contact.projectileMassKg / candidate.contact.targetMassKg;
    const trustedRadiusSumMeters =
      candidate.contact.targetRadiusMeters + candidate.contact.projectileRadiusMeters;
    const trustedImpactParameter = Math.sin(candidate.contact.impactAngleRadians);
    const trustedInteractingLengthMeters = Math.min(
      2 * candidate.contact.projectileRadiusMeters,
      Math.max(0, trustedRadiusSumMeters * (1 - trustedImpactParameter)),
    );
    const trustedInteractingLengthRadiusRatio =
      trustedInteractingLengthMeters / candidate.contact.projectileRadiusMeters;
    const trustedInteractingFraction = Math.min(
      1,
      Math.max(
        0,
        trustedInteractingLengthMeters >= 2 * candidate.contact.projectileRadiusMeters
          ? 1
          : (3 * trustedInteractingLengthRadiusRatio ** 2 -
              trustedInteractingLengthRadiusRatio ** 3) /
              4,
      ),
    );
    const trustedInteractingMassKg =
      trustedInteractingFraction * candidate.contact.projectileMassKg;
    const trustedInteractingReducedMassKg =
      trustedInteractingMassKg > 0
        ? trustedInteractingMassKg / (1 + trustedInteractingMassKg / candidate.contact.targetMassKg)
        : 0;
    const trustedEscapeSpeedMetersPerSecond = Math.sqrt(
      (2 * GRAVITATIONAL_CONSTANT_SI * trustedTotalMassKg) / trustedRadiusSumMeters,
    );
    const trustedSpecificImpactEnergyJoulesPerKg =
      0.5 *
      (trustedReducedMassKg / trustedTotalMassKg) *
      candidate.contact.impactSpeedMetersPerSecond ** 2;
    const trustedContact = {
      ...candidate.contact,
      totalMassKg: trustedTotalMassKg,
      reducedMassKg: trustedReducedMassKg,
      interactingReducedMassKg: trustedInteractingReducedMassKg,
      interactingProjectileFraction: trustedInteractingFraction,
      massRatio: trustedMassRatio,
      impactParameter: trustedImpactParameter,
      mutualEscapeSpeedMetersPerSecond: trustedEscapeSpeedMetersPerSecond,
      specificImpactEnergyJoulesPerKg: trustedSpecificImpactEnergyJoulesPerKg,
      grazing:
        trustedImpactParameter > candidate.contact.targetRadiusMeters / trustedRadiusSumMeters,
    };
    const expectedDisruption = computeDisruptionFormula(trustedContact, disruption.materialProfile);
    const disruptionChecks = [
      [
        'equivalentCombinedRadiusMeters',
        disruption.equivalentCombinedRadiusMeters,
        expectedDisruption.equivalentCombinedRadiusMeters,
      ],
      [
        'principalDisruptionThresholdJoulesPerKg',
        disruption.principalDisruptionThresholdJoulesPerKg,
        expectedDisruption.principalDisruptionThresholdJoulesPerKg,
      ],
      ['massRatioScale', disruption.massRatioScale, expectedDisruption.massRatioScale],
      [
        'headOnDisruptionThresholdJoulesPerKg',
        disruption.headOnDisruptionThresholdJoulesPerKg,
        expectedDisruption.headOnDisruptionThresholdJoulesPerKg,
      ],
      ['obliquityScale', disruption.obliquityScale, expectedDisruption.obliquityScale],
      [
        'disruptionThresholdJoulesPerKg',
        disruption.disruptionThresholdJoulesPerKg,
        expectedDisruption.disruptionThresholdJoulesPerKg,
      ],
      [
        'criticalImpactSpeedMetersPerSecond',
        disruption.criticalImpactSpeedMetersPerSecond,
        expectedDisruption.criticalImpactSpeedMetersPerSecond,
      ],
      [
        'normalizedImpactEnergy',
        disruption.normalizedImpactEnergy,
        expectedDisruption.normalizedImpactEnergy,
      ],
    ] as const;
    for (const [path, actual, expected] of disruptionChecks) {
      if (!approximatelyEqual(actual, expected)) {
        addConsistencyIssue(context, ['disruption', path], `${path} 与接触量不一致`);
      }
    }
    if (disruption.obliquityModelExtrapolated !== expectedDisruption.obliquityModelExtrapolated) {
      addConsistencyIssue(
        context,
        ['disruption', 'obliquityModelExtrapolated'],
        'LS2012 斜碰适用范围标记不一致',
      );
    }

    const normalizedEnergy = expectedDisruption.normalizedImpactEnergy;
    const expectedLargestFraction = computeLargestRemnantMassFractionFormula(normalizedEnergy);
    const expectedGendaRatio = computeGendaCriticalVelocityRatioFormula(
      trustedMassRatio,
      trustedImpactParameter,
    );
    const classificationEvaluation = evaluateCollisionClassification(
      trustedContact,
      normalizedEnergy,
      expectedGendaRatio,
    );
    if (classificationEvaluation.gendaRequired) {
      if (
        candidate.gendaCriticalVelocityRatio === null ||
        candidate.gendaModelExtrapolated === null
      ) {
        addConsistencyIssue(context, ['gendaCriticalVelocityRatio'], '擦碰候选缺少 Genda 临界线');
      } else {
        if (!approximatelyEqual(candidate.gendaCriticalVelocityRatio, expectedGendaRatio)) {
          addConsistencyIssue(context, ['gendaCriticalVelocityRatio'], 'Genda 临界速度比不一致');
        }
        const outsideNumericScope = isGendaNumericExtrapolation(trustedContact);
        if (outsideNumericScope && !candidate.gendaModelExtrapolated) {
          addConsistencyIssue(context, ['gendaModelExtrapolated'], 'Genda 数值范围外必须标记外推');
        }
      }
    } else if (
      candidate.gendaCriticalVelocityRatio !== null ||
      candidate.gendaModelExtrapolated !== null
    ) {
      addConsistencyIssue(context, ['gendaCriticalVelocityRatio'], '当前分类不应使用 Genda 临界线');
    }

    const expectedClassification = classificationEvaluation.classification;
    if (expectedClassification !== null && candidate.classification !== expectedClassification) {
      addConsistencyIssue(context, ['classification'], '碰撞分类与接触量和能量不一致');
    }

    if (expectedClassification === null) {
      return;
    }
    if (expectedClassification === 'merge' || expectedClassification === 'grazeAndMerge') {
      if (
        candidate.largestRemnantMassFraction === null ||
        !approximatelyEqual(candidate.largestRemnantMassFraction, 1) ||
        candidate.largestRemnantMassKg === null ||
        !approximatelyEqual(candidate.largestRemnantMassKg, candidate.contact.totalMassKg)
      ) {
        addConsistencyIssue(context, ['largestRemnantMassKg'], '合并结果的最大残体必须等于总质量');
      }
    } else if (expectedClassification === 'hitAndRun') {
      if (
        candidate.largestRemnantMassFraction !== null ||
        candidate.largestRemnantMassKg !== null
      ) {
        addConsistencyIssue(
          context,
          ['largestRemnantMassKg'],
          'hit-and-run 首版不报告 Eq.5 最大残体',
        );
      }
    } else {
      if (
        candidate.largestRemnantMassFraction === null ||
        candidate.largestRemnantMassKg === null ||
        !approximatelyEqual(candidate.largestRemnantMassFraction, expectedLargestFraction) ||
        !approximatelyEqual(
          candidate.largestRemnantMassKg,
          expectedLargestFraction * candidate.contact.totalMassKg,
        )
      ) {
        addConsistencyIssue(context, ['largestRemnantMassKg'], '最大残体与 universal law 不一致');
      }
    }
  });

export const absoluteMaterialMassesSchema = z.strictObject({
  gas: nonNegativeFiniteNumberSchema,
  ice: nonNegativeFiniteNumberSchema,
  silicate: nonNegativeFiniteNumberSchema,
  iron: nonNegativeFiniteNumberSchema,
});

export const passiveCollisionAssetSchema = z.strictObject({
  id: identifierSchema,
  massKg: positiveFiniteNumberSchema,
  positionMeters: collisionVectorSchema,
  velocityMetersPerSecond: collisionVectorSchema,
  materialLayers: materialLayersSchema.min(1),
  subgridMechanicalEnergyJoules: nonNegativeFiniteNumberSchema,
});

export const collisionEventStateSchema = z
  .strictObject({
    majorBodies: z.array(collisionBodySnapshotSchema).max(MAX_COLLISION_MAJOR_BODIES),
    tracers: z.array(passiveCollisionAssetSchema).max(MAX_COLLISION_PASSIVE_ASSETS),
    dustCohorts: z.array(passiveCollisionAssetSchema).max(MAX_COLLISION_PASSIVE_ASSETS),
  })
  .superRefine((state, context) => {
    const seenIds = new Set<string>();
    const groups = [
      ['majorBodies', state.majorBodies],
      ['tracers', state.tracers],
      ['dustCohorts', state.dustCohorts],
    ] as const;
    groups.forEach(([groupName, assets]) => {
      assets.forEach((asset, assetIndex) => {
        if (seenIds.has(asset.id)) {
          context.addIssue({
            code: 'custom',
            message: `碰撞资产 id 重复：${asset.id}`,
            path: [groupName, assetIndex, 'id'],
          });
        }
        seenIds.add(asset.id);
      });
    });
  });

export const collisionDissipationSchema = z.strictObject({
  heatJoules: nonNegativeFiniteNumberSchema,
  deformationJoules: nonNegativeFiniteNumberSchema,
  fractureJoules: nonNegativeFiniteNumberSchema,
  radiationJoules: nonNegativeFiniteNumberSchema,
});

const reservoirMassesSchema = z.strictObject({
  majorKg: nonNegativeFiniteNumberSchema,
  tracerKg: nonNegativeFiniteNumberSchema,
  dustKg: nonNegativeFiniteNumberSchema,
  totalKg: nonNegativeFiniteNumberSchema,
});

const mechanicalEnergyComponentsSchema = z.strictObject({
  translationalJoules: nonNegativeFiniteNumberSchema,
  spinJoules: nonNegativeFiniteNumberSchema,
  activeActivePotentialJoules: finiteNumberSchema,
  activePassivePotentialJoules: finiteNumberSchema,
  selfBindingJoules: finiteNumberSchema,
  subgridJoules: nonNegativeFiniteNumberSchema,
  totalJoules: finiteNumberSchema,
});

const eventMechanicalTotalsSchema = z.strictObject({
  reservoirMasses: reservoirMassesSchema,
  materialMassesKg: absoluteMaterialMassesSchema,
  linearMomentumKgMetersPerSecond: collisionVectorSchema,
  angularMomentumKgMetersSquaredPerSecond: collisionVectorSchema,
  energy: mechanicalEnergyComponentsSchema,
});

const conservationCheckSchema = z.strictObject({
  absoluteError: nonNegativeFiniteNumberSchema,
  scale: positiveFiniteNumberSchema,
  normalizedError: nonNegativeFiniteNumberSchema,
  threshold: positiveFiniteNumberSchema,
  passed: z.boolean(),
});

const materialConservationChecksSchema = z.strictObject({
  gas: conservationCheckSchema,
  ice: conservationCheckSchema,
  silicate: conservationCheckSchema,
  iron: conservationCheckSchema,
});

export const omittedInteractionClassSchema = z.enum([
  'tracerTracerGravity',
  'tracerDustGravity',
  'dustDustGravity',
  'passiveBackreaction',
]);

export const collisionLedgerSchema = z.strictObject({
  ledgerVersion: z.literal(COLLISION_LEDGER_VERSION),
  modelVersion: z.literal(COLLISION_MODEL_VERSION),
  eventId: identifierSchema,
  simulationTimeSeconds: nonNegativeFiniteNumberSchema,
  referenceFrame: z.strictObject({
    originMeters: collisionVectorSchema,
    velocityMetersPerSecond: collisionVectorSchema,
  }),
  before: eventMechanicalTotalsSchema,
  after: eventMechanicalTotalsSchema,
  dissipation: collisionDissipationSchema,
  checks: z.strictObject({
    mass: conservationCheckSchema,
    materialMasses: materialConservationChecksSchema,
    linearMomentum: conservationCheckSchema,
    angularMomentum: conservationCheckSchema,
    energy: conservationCheckSchema,
  }),
  omittedInteractionClasses: z.array(omittedInteractionClassSchema),
  passed: z.boolean(),
});

export const deterministicSeedInputSchema = z.strictObject({
  eventId: identifierSchema,
  firstParentId: identifierSchema,
  secondParentId: identifierSchema,
  fragmentKind: z.enum(['major', 'tracer', 'dust']),
  fragmentOrdinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export type CollisionVector = z.infer<typeof collisionVectorSchema>;
export type CollisionMaterial = z.infer<typeof collisionMaterialSchema>;
export type MaterialLayer = z.infer<typeof materialLayerSchema>;
export type CollisionBodySnapshot = z.infer<typeof collisionBodySnapshotSchema>;
export type CollisionInput = z.infer<typeof collisionInputSchema>;
export type ContactQuantities = z.infer<typeof contactQuantitiesSchema>;
export type DisruptionScaling = z.infer<typeof disruptionScalingSchema>;
export type CollisionClassification = z.infer<typeof collisionClassificationSchema>;
export type CollisionResolutionCandidate = z.infer<typeof collisionResolutionCandidateSchema>;
export type AbsoluteMaterialMasses = z.infer<typeof absoluteMaterialMassesSchema>;
export type PassiveCollisionAsset = z.infer<typeof passiveCollisionAssetSchema>;
export type CollisionEventState = z.infer<typeof collisionEventStateSchema>;
export type CollisionDissipation = z.infer<typeof collisionDissipationSchema>;
export type CollisionLedger = z.infer<typeof collisionLedgerSchema>;
export type DeterministicSeedInput = z.infer<typeof deterministicSeedInputSchema>;
