import { z } from 'zod';

import {
  collisionClassificationSchema,
  collisionDissipationSchema,
  collisionModelSchema,
  materialLayersSchema,
  omittedInteractionClassSchema,
  passiveCollisionAssetSchema,
} from '../collisions/schemas';
import {
  MAX_COLLISION_MAJOR_BODIES,
  MAX_COLLISION_MAJOR_REMNANTS,
  MAX_COLLISION_PASSIVE_ASSETS,
} from '../collisions/model-sources';
import { compensatedSum } from '../collisions/vector';

export type { PassiveCollisionAsset } from '../collisions/schemas';

const finiteNumberSchema = z.number();
const nonNegativeFiniteNumberSchema = finiteNumberSchema.nonnegative();
const positiveFiniteNumberSchema = finiteNumberSchema.positive();
const safeNonNegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PASSIVE_DIAGNOSTIC_RELATIVE_TOLERANCE = 1e-12;

function approximatelyEqual(value: number, expected: number, scale: number): boolean {
  if (!Number.isFinite(expected) || !Number.isFinite(scale)) {
    return false;
  }
  const comparisonScale = Math.max(Math.abs(value), Math.abs(expected), scale, Number.MIN_VALUE);
  return Math.abs(value - expected) <= PASSIVE_DIAGNOSTIC_RELATIVE_TOLERANCE * comparisonScale;
}

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

export const physicsIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0, '标识不能为空白')
  .refine(isWellFormedUnicode, '标识必须是完整 Unicode 字符串');

export const positionMetersSchema = z.strictObject({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  z: finiteNumberSchema,
});

export const velocityMetersPerSecondSchema = positionMetersSchema;
export const linearMomentumKgMetersPerSecondSchema = positionMetersSchema;
export const angularMomentumKgMetersSquaredPerSecondSchema = positionMetersSchema;

export const bodyStateSchema = z
  .strictObject({
    id: physicsIdentifierSchema,
    massKg: positiveFiniteNumberSchema,
    radiusMeters: nonNegativeFiniteNumberSchema,
    positionMeters: positionMetersSchema,
    velocityMetersPerSecond: velocityMetersPerSecondSchema,
    spinAngularMomentumKgMetersSquaredPerSecond: angularMomentumKgMetersSquaredPerSecondSchema,
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
        message: '非黑洞天体至少需要一个材料层',
        path: ['materialLayers'],
      });
    }
    if (body.momentOfInertiaFactor === null) {
      context.addIssue({
        code: 'custom',
        message: '非黑洞天体必须提供转动惯量因子',
        path: ['momentOfInertiaFactor'],
      });
    }
  });

export const bodyStatesSchema = z
  .array(bodyStateSchema)
  .min(1)
  .max(MAX_COLLISION_MAJOR_BODIES)
  .superRefine((bodies, context) => {
    const seenIds = new Set<string>();
    bodies.forEach((body, index) => {
      if (seenIds.has(body.id)) {
        context.addIssue({
          code: 'custom',
          message: `天体 id 重复：${body.id}`,
          path: [index, 'id'],
        });
      }
      seenIds.add(body.id);
    });
  });

export const activeReboundDiagnosticsSchema = z.strictObject({
  totalEnergyJoules: finiteNumberSchema,
  totalLinearMomentumKgMetersPerSecond: linearMomentumKgMetersPerSecondSchema,
  totalAngularMomentumKgMetersSquaredPerSecond: angularMomentumKgMetersSquaredPerSecondSchema,
});

export const passiveAssetDiagnosticsSchema = z.strictObject({
  totalMassKg: nonNegativeFiniteNumberSchema,
  totalLinearMomentumKgMetersPerSecond: linearMomentumKgMetersPerSecondSchema,
  totalAngularMomentumKgMetersSquaredPerSecond: angularMomentumKgMetersSquaredPerSecondSchema,
  totalMechanicalEnergyJoules: finiteNumberSchema,
});

export const physicsDiagnosticsSchema = activeReboundDiagnosticsSchema;

export const layeredPhysicsDiagnosticsSchema = z.strictObject({
  activeRebound: activeReboundDiagnosticsSchema,
  passiveAssets: passiveAssetDiagnosticsSchema,
});

export const cumulativeCollisionLedgerSchema = z.strictObject({
  resolvedEventCount: safeNonNegativeIntegerSchema,
  accumulatedDissipation: collisionDissipationSchema,
});

export const cumulativeOmittedBackreactionSchema = z.strictObject({
  linearImpulseKgMetersPerSecond: linearMomentumKgMetersPerSecondSchema,
  angularImpulseKgMetersSquaredPerSecond: angularMomentumKgMetersSquaredPerSecondSchema,
  workJoules: finiteNumberSchema,
});

const omittedInteractionClassesSchema = z
  .array(omittedInteractionClassSchema)
  .max(4)
  .superRefine((classes, context) => {
    const seen = new Set<string>();
    classes.forEach((interactionClass, index) => {
      if (seen.has(interactionClass)) {
        context.addIssue({
          code: 'custom',
          message: `省略相互作用类别重复：${interactionClass}`,
          path: [index],
        });
      }
      seen.add(interactionClass);
    });
  });

export const physicsStateSchema = z
  .strictObject({
    majorBodies: bodyStatesSchema,
    tracers: z.array(passiveCollisionAssetSchema).max(MAX_COLLISION_PASSIVE_ASSETS),
    dustCohorts: z.array(passiveCollisionAssetSchema).max(MAX_COLLISION_PASSIVE_ASSETS),
    cumulativeCollisionLedger: cumulativeCollisionLedgerSchema,
    omittedInteractionClasses: omittedInteractionClassesSchema,
    cumulativeOmittedBackreaction: cumulativeOmittedBackreactionSchema,
    diagnostics: layeredPhysicsDiagnosticsSchema,
  })
  .superRefine((state, context) => {
    if (state.tracers.length + state.dustCohorts.length > MAX_COLLISION_PASSIVE_ASSETS) {
      context.addIssue({
        code: 'custom',
        message: `tracer 与 dust cohort 合计不能超过 ${String(MAX_COLLISION_PASSIVE_ASSETS)}`,
        path: ['tracers'],
      });
    }
    const seenIds = new Set<string>();
    const groups = [
      ['majorBodies', state.majorBodies],
      ['tracers', state.tracers],
      ['dustCohorts', state.dustCohorts],
    ] as const;
    for (const [groupName, assets] of groups) {
      assets.forEach((asset, index) => {
        if (seenIds.has(asset.id)) {
          context.addIssue({
            code: 'custom',
            message: `物理状态资产 id 重复：${asset.id}`,
            path: [groupName, index, 'id'],
          });
        }
        seenIds.add(asset.id);
      });
    }

    const passives = [...state.tracers, ...state.dustCohorts];
    const massTerms = passives.map((asset) => asset.massKg);
    const momentumTerms = passives.map((asset) => ({
      x: asset.massKg * asset.velocityMetersPerSecond.x,
      y: asset.massKg * asset.velocityMetersPerSecond.y,
      z: asset.massKg * asset.velocityMetersPerSecond.z,
    }));
    const angularTerms = passives.map((asset) => {
      const momentum = {
        x: asset.massKg * asset.velocityMetersPerSecond.x,
        y: asset.massKg * asset.velocityMetersPerSecond.y,
        z: asset.massKg * asset.velocityMetersPerSecond.z,
      };
      return {
        x: asset.positionMeters.y * momentum.z - asset.positionMeters.z * momentum.y,
        y: asset.positionMeters.z * momentum.x - asset.positionMeters.x * momentum.z,
        z: asset.positionMeters.x * momentum.y - asset.positionMeters.y * momentum.x,
      };
    });
    const expectedMass = compensatedSum(massTerms);
    const expectedMomentum = {
      x: compensatedSum(momentumTerms.map((term) => term.x)),
      y: compensatedSum(momentumTerms.map((term) => term.y)),
      z: compensatedSum(momentumTerms.map((term) => term.z)),
    };
    const expectedAngularMomentum = {
      x: compensatedSum(angularTerms.map((term) => term.x)),
      y: compensatedSum(angularTerms.map((term) => term.y)),
      z: compensatedSum(angularTerms.map((term) => term.z)),
    };
    const diagnostics = state.diagnostics.passiveAssets;
    if (!approximatelyEqual(diagnostics.totalMassKg, expectedMass, expectedMass)) {
      context.addIssue({
        code: 'custom',
        message: '被动资产诊断总质量与 tracer/dust cohort 不一致',
        path: ['diagnostics', 'passiveAssets', 'totalMassKg'],
      });
    }
    const diagnosticVectors = [
      [
        'totalLinearMomentumKgMetersPerSecond',
        diagnostics.totalLinearMomentumKgMetersPerSecond,
        expectedMomentum,
        momentumTerms,
      ],
      [
        'totalAngularMomentumKgMetersSquaredPerSecond',
        diagnostics.totalAngularMomentumKgMetersSquaredPerSecond,
        expectedAngularMomentum,
        angularTerms,
      ],
    ] as const;
    for (const [field, actual, expected, terms] of diagnosticVectors) {
      (['x', 'y', 'z'] as const).forEach((component) => {
        const scale = compensatedSum(terms.map((term) => Math.abs(term[component])));
        if (!approximatelyEqual(actual[component], expected[component], scale)) {
          context.addIssue({
            code: 'custom',
            message: `被动资产诊断 ${field}.${component} 与 tracer/dust cohort 不一致`,
            path: ['diagnostics', 'passiveAssets', field, component],
          });
        }
      });
    }
  });

export const collisionEventSchema = z
  .strictObject({
    eventId: physicsIdentifierSchema,
    modelVersion: z.string().min(1).max(128),
    participantBodyIds: z.tuple([physicsIdentifierSchema, physicsIdentifierSchema]),
    classification: collisionClassificationSchema.or(z.literal('blackHoleAccretion')),
    specificImpactEnergyJoulesPerKg: nonNegativeFiniteNumberSchema,
    disruptionThresholdJoulesPerKg: positiveFiniteNumberSchema.nullable(),
    normalizedImpactEnergy: nonNegativeFiniteNumberSchema.nullable(),
    impactAngleRadians: nonNegativeFiniteNumberSchema.max(Math.PI / 2),
    modelExtrapolated: z.boolean(),
    majorRemnantIds: z.array(physicsIdentifierSchema).max(MAX_COLLISION_MAJOR_REMNANTS),
    tracerIds: z.array(physicsIdentifierSchema).max(MAX_COLLISION_PASSIVE_ASSETS),
    dustCohortIds: z.array(physicsIdentifierSchema).max(MAX_COLLISION_PASSIVE_ASSETS),
  })
  .superRefine((event, context) => {
    if (event.participantBodyIds[0] === event.participantBodyIds[1]) {
      context.addIssue({
        code: 'custom',
        message: '碰撞事件参与体必须不同',
        path: ['participantBodyIds', 1],
      });
    }
    const resultIds = [...event.majorRemnantIds, ...event.tracerIds, ...event.dustCohortIds];
    if (new Set(resultIds).size !== resultIds.length) {
      context.addIssue({ code: 'custom', message: '碰撞事件结果 id 不能重复' });
    }
  });

export type PositionMeters = z.infer<typeof positionMetersSchema>;
export type VelocityMetersPerSecond = z.infer<typeof velocityMetersPerSecondSchema>;
export type LinearMomentumKgMetersPerSecond = z.infer<typeof linearMomentumKgMetersPerSecondSchema>;
export type AngularMomentumKgMetersSquaredPerSecond = z.infer<
  typeof angularMomentumKgMetersSquaredPerSecondSchema
>;
export type BodyState = z.infer<typeof bodyStateSchema>;
export type ActiveReboundDiagnostics = z.infer<typeof activeReboundDiagnosticsSchema>;
export type PassiveAssetDiagnostics = z.infer<typeof passiveAssetDiagnosticsSchema>;
export type PhysicsDiagnostics = z.infer<typeof physicsDiagnosticsSchema>;
export type LayeredPhysicsDiagnostics = z.infer<typeof layeredPhysicsDiagnosticsSchema>;
export type PhysicsState = z.infer<typeof physicsStateSchema>;
export type CollisionEvent = z.infer<typeof collisionEventSchema>;
