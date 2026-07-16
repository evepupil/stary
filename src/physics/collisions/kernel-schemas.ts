import { z } from 'zod';

import {
  COLLISION_CONSERVATION_LIMITS,
  COLLISION_MODEL_VERSION,
  MAX_COLLISION_MAJOR_BODIES,
  MAX_COLLISION_MAJOR_REMNANTS,
  MAX_COLLISION_PASSIVE_ASSETS,
} from './model-sources';
import {
  absoluteMaterialMassesSchema,
  collisionBodySnapshotSchema,
  collisionDissipationSchema,
  collisionEventStateSchema,
  collisionInputSchema,
  collisionLedgerSchema,
  collisionResolutionCandidateSchema,
} from './schemas';
import { compareUtf8 } from './stable-order';

export const COLLISION_KERNEL_ABI_VERSION = 1 as const;
export const COLLISION_RECONSTRUCTION_VERSION = 'stary-deterministic-v1' as const;
export const BLACK_HOLE_ACCRETION_LEDGER_VERSION = 1 as const;

export const COLLISION_RECONSTRUCTION_APPROXIMATIONS = {
  combinedMaterialBuckets: '两体材料先按四种材料桶合并，再从外到内剥离',
  participantLocalLedger: 'Task 4 参考账本只覆盖本次二体参与者和本次生成资产',
  passiveFragment: '破坏结果把最大残体以外的质量聚合成一个 tracer 或 dust cohort',
  remnantDensity: '主要残体按两体总体积的平均密度重建球形半径',
  separationKinematics: '碎裂结果用守恒角动量的切向速度和有界径向分离速度重建',
  blackHoleAccretion: '黑洞使用牛顿质心吞噬，未模拟引力波质量损失和 Kerr 上限',
} as const;

export const COLLISION_KERNEL_CAPACITY_SEMANTICS =
  '容量字段统计本批次全部结果资产；参与体被替换前占用的旧槽位由调用方提前扣除或归还' as const;

export const collisionReconstructionApproximationSchema = z.enum([
  'combinedMaterialBuckets',
  'participantLocalLedger',
  'passiveFragment',
  'remnantDensity',
  'separationKinematics',
  'blackHoleAccretion',
]);

const finiteNumberSchema = z.number();
const nonNegativeFiniteNumberSchema = finiteNumberSchema.nonnegative();
const safeNonNegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const disruptionMaterialProfileSchema = z.enum(['gravitySolid', 'gravityFluid']);

const classicCollisionKernelEventRequestSchema = z.strictObject({
  domain: z.literal('classic'),
  input: collisionInputSchema,
  expectedMaterialProfile: disruptionMaterialProfileSchema,
});

const blackHoleCollisionKernelEventRequestSchema = z.strictObject({
  domain: z.literal('blackHoleAccretion'),
  input: collisionInputSchema,
  expectedMaterialProfile: z.null(),
});

export const collisionKernelEventRequestSchema = z.discriminatedUnion('domain', [
  classicCollisionKernelEventRequestSchema,
  blackHoleCollisionKernelEventRequestSchema,
]);

export const collisionKernelCapacitySchema = z.strictObject({
  majorRemnantSlots: safeNonNegativeIntegerSchema.max(MAX_COLLISION_MAJOR_BODIES),
  passiveAssetSlots: safeNonNegativeIntegerSchema.max(MAX_COLLISION_PASSIVE_ASSETS),
});

export const collisionKernelBatchRequestSchema = z
  .strictObject({
    abiVersion: z.literal(COLLISION_KERNEL_ABI_VERSION),
    modelVersion: z.literal(COLLISION_MODEL_VERSION),
    reconstructionVersion: z.literal(COLLISION_RECONSTRUCTION_VERSION),
    capacity: collisionKernelCapacitySchema,
    events: z
      .array(collisionKernelEventRequestSchema)
      .min(1)
      .max(Math.floor(MAX_COLLISION_MAJOR_BODIES / 2)),
  })
  .superRefine((request, context) => {
    const eventIds = new Set<string>();
    const participantOwner = new Map<string, string>();
    request.events.forEach((event, eventIndex) => {
      const { eventId, firstBody, secondBody } = event.input;
      if (eventIds.has(eventId)) {
        context.addIssue({
          code: 'custom',
          message: `碰撞内核事件 id 重复：${eventId}`,
          path: ['events', eventIndex, 'input', 'eventId'],
        });
      }
      eventIds.add(eventId);
      for (const body of [firstBody, secondBody]) {
        const owner = participantOwner.get(body.id);
        if (owner !== undefined) {
          context.addIssue({
            code: 'custom',
            message: `碰撞内核批次包含共享参与体：${body.id}，已属于 ${owner}`,
            path: ['events', eventIndex, 'input'],
          });
        } else {
          participantOwner.set(body.id, eventId);
        }
      }
    });
  });

const classicCollisionKernelResolutionSchema = z
  .strictObject({
    domain: z.literal('classic'),
    eventId: z.string().min(1).max(128),
    participantBodyIds: z.tuple([z.string().min(1).max(128), z.string().min(1).max(128)]),
    expectedMaterialProfile: disruptionMaterialProfileSchema,
    ledgerScope: z.literal('participantLocalEventTotal'),
    candidate: collisionResolutionCandidateSchema,
    after: collisionEventStateSchema,
    dissipation: collisionDissipationSchema,
    ledger: collisionLedgerSchema,
    majorRemnantIds: z.array(z.string().min(1).max(128)).max(MAX_COLLISION_MAJOR_REMNANTS),
    tracerIds: z.array(z.string().min(1).max(128)).max(MAX_COLLISION_PASSIVE_ASSETS),
    dustCohortIds: z.array(z.string().min(1).max(128)).max(MAX_COLLISION_PASSIVE_ASSETS),
    approximations: z.array(collisionReconstructionApproximationSchema),
  })
  .superRefine((resolution, context) => {
    if (resolution.ledger.eventId !== resolution.eventId) {
      context.addIssue({
        code: 'custom',
        message: '经典碰撞账本 eventId 不一致',
        path: ['ledger'],
      });
    }
    const ledgerChecks = resolution.ledger.checks;
    const ledgerChecksPassed =
      ledgerChecks.mass.passed &&
      ledgerChecks.linearMomentum.passed &&
      ledgerChecks.angularMomentum.passed &&
      ledgerChecks.energy.passed &&
      Object.values(ledgerChecks.materialMasses).every((check) => check.passed);
    if (!resolution.ledger.passed || !ledgerChecksPassed) {
      context.addIssue({ code: 'custom', message: '成功结果不能包含未通过账本', path: ['ledger'] });
    }
    const candidateParticipants = new Set([
      resolution.candidate.contact.targetBodyId,
      resolution.candidate.contact.projectileBodyId,
    ]);
    if (
      candidateParticipants.size !== 2 ||
      resolution.participantBodyIds.some((id) => !candidateParticipants.has(id))
    ) {
      context.addIssue({
        code: 'custom',
        message: '经典碰撞参与体与候选接触量不一致',
        path: ['participantBodyIds'],
      });
    }
    const expectedGroups = [
      ['majorRemnantIds', resolution.majorRemnantIds, resolution.after.majorBodies],
      ['tracerIds', resolution.tracerIds, resolution.after.tracers],
      ['dustCohortIds', resolution.dustCohortIds, resolution.after.dustCohorts],
    ] as const;
    for (const [field, ids, assets] of expectedGroups) {
      const actualIds = new Set(assets.map((asset) => asset.id));
      if (ids.length !== actualIds.size || ids.some((id) => !actualIds.has(id))) {
        context.addIssue({
          code: 'custom',
          message: `${field} 与经典碰撞 after 状态不一致`,
          path: [field],
        });
      }
    }
  });

const conservationCheckSchema = z.strictObject({
  absoluteError: nonNegativeFiniteNumberSchema,
  scale: finiteNumberSchema.positive(),
  normalizedError: nonNegativeFiniteNumberSchema,
  threshold: finiteNumberSchema.positive(),
  passed: z.boolean(),
});

const collisionVectorSchema = z.strictObject({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  z: finiteNumberSchema,
});

export const blackHoleAccretionLedgerSchema = z
  .strictObject({
    ledgerVersion: z.literal(BLACK_HOLE_ACCRETION_LEDGER_VERSION),
    modelVersion: z.literal(COLLISION_MODEL_VERSION),
    reconstructionVersion: z.literal(COLLISION_RECONSTRUCTION_VERSION),
    eventId: z.string().min(1).max(128),
    simulationTimeSeconds: nonNegativeFiniteNumberSchema,
    referenceFrame: z.strictObject({
      originMeters: collisionVectorSchema,
      velocityMetersPerSecond: collisionVectorSchema,
    }),
    energyScope: z.literal('relativeKineticOnly'),
    mass: z.strictObject({
      beforeKg: finiteNumberSchema.positive(),
      afterKg: finiteNumberSchema.positive(),
      check: conservationCheckSchema,
    }),
    linearMomentum: z.strictObject({
      beforeKgMetersPerSecond: collisionVectorSchema,
      afterKgMetersPerSecond: collisionVectorSchema,
      check: conservationCheckSchema,
    }),
    angularMomentum: z.strictObject({
      beforeKgMetersSquaredPerSecond: collisionVectorSchema,
      afterKgMetersSquaredPerSecond: collisionVectorSchema,
      check: conservationCheckSchema,
    }),
    relativeKineticEnergy: z.strictObject({
      beforeJoules: nonNegativeFiniteNumberSchema,
      afterJoules: nonNegativeFiniteNumberSchema,
      radiationJoules: nonNegativeFiniteNumberSchema,
      check: conservationCheckSchema,
    }),
    accretedMaterialMassesKg: absoluteMaterialMassesSchema,
    limits: z.strictObject({
      mass: z.literal(COLLISION_CONSERVATION_LIMITS.mass),
      linearMomentum: z.literal(COLLISION_CONSERVATION_LIMITS.linearMomentum),
      angularMomentum: z.literal(COLLISION_CONSERVATION_LIMITS.angularMomentum),
      energy: z.literal(COLLISION_CONSERVATION_LIMITS.energy),
    }),
    passed: z.boolean(),
  })
  .superRefine((ledger, context) => {
    const checksPassed =
      ledger.mass.check.passed &&
      ledger.linearMomentum.check.passed &&
      ledger.angularMomentum.check.passed &&
      ledger.relativeKineticEnergy.check.passed;
    if (ledger.passed !== checksPassed) {
      context.addIssue({ code: 'custom', message: '黑洞账本 passed 与分项检查不一致' });
    }
  });

const blackHoleCollisionKernelResolutionSchema = z
  .strictObject({
    domain: z.literal('blackHoleAccretion'),
    eventId: z.string().min(1).max(128),
    participantBodyIds: z.tuple([z.string().min(1).max(128), z.string().min(1).max(128)]),
    remnant: collisionBodySnapshotSchema,
    after: collisionEventStateSchema,
    ledger: blackHoleAccretionLedgerSchema,
    approximations: z.tuple([z.literal('blackHoleAccretion')]),
  })
  .superRefine((resolution, context) => {
    if (resolution.participantBodyIds[0] === resolution.participantBodyIds[1]) {
      context.addIssue({
        code: 'custom',
        message: '黑洞吞噬参与体必须不同',
        path: ['participantBodyIds', 1],
      });
    }
    if (resolution.remnant.collisionModel !== 'blackHole') {
      context.addIssue({ code: 'custom', message: '吞噬残体必须是黑洞', path: ['remnant'] });
    }
    if (
      resolution.after.majorBodies.length !== 1 ||
      resolution.after.majorBodies[0]?.id !== resolution.remnant.id ||
      resolution.after.tracers.length !== 0 ||
      resolution.after.dustCohorts.length !== 0
    ) {
      context.addIssue({ code: 'custom', message: '黑洞吞噬 after 状态不一致', path: ['after'] });
    }
    if (resolution.ledger.eventId !== resolution.eventId || !resolution.ledger.passed) {
      context.addIssue({ code: 'custom', message: '黑洞吞噬账本无效', path: ['ledger'] });
    }
  });

export const collisionKernelEventResolutionSchema = z.discriminatedUnion('domain', [
  classicCollisionKernelResolutionSchema,
  blackHoleCollisionKernelResolutionSchema,
]);

export const collisionKernelErrorCodeSchema = z.enum([
  'malformedInput',
  'unsupportedCollisionDomain',
  'unsupportedStellarCollision',
  'unsupportedStrengthRegime',
  'collisionCapacityExceeded',
  'collisionReconstructionFailed',
  'collisionConservationFailed',
  'collisionNumericalFailure',
  'duplicateOutputId',
]);

const collisionKernelEnvelopeBase = {
  abiVersion: z.literal(COLLISION_KERNEL_ABI_VERSION),
  modelVersion: z.literal(COLLISION_MODEL_VERSION),
  reconstructionVersion: z.literal(COLLISION_RECONSTRUCTION_VERSION),
} as const;

const collisionKernelSuccessResponseSchema = z
  .strictObject({
    ...collisionKernelEnvelopeBase,
    kind: z.literal('success'),
    events: z.array(collisionKernelEventResolutionSchema).min(1),
  })
  .superRefine((response, context) => {
    const eventIds = new Set<string>();
    const outputIds = new Set<string>();
    let previousEventId: string | null = null;
    response.events.forEach((event, eventIndex) => {
      if (eventIds.has(event.eventId)) {
        context.addIssue({
          code: 'custom',
          message: `碰撞内核响应事件 id 重复：${event.eventId}`,
          path: ['events', eventIndex, 'eventId'],
        });
      }
      eventIds.add(event.eventId);
      if (previousEventId !== null && compareUtf8(previousEventId, event.eventId) >= 0) {
        context.addIssue({
          code: 'custom',
          message: '碰撞内核响应事件必须按 UTF-8 eventId 严格递增',
          path: ['events', eventIndex, 'eventId'],
        });
      }
      previousEventId = event.eventId;
      const ids =
        event.domain === 'classic'
          ? [...event.majorRemnantIds, ...event.tracerIds, ...event.dustCohortIds]
          : [event.remnant.id];
      for (const id of ids) {
        if (outputIds.has(id)) {
          context.addIssue({
            code: 'custom',
            message: `碰撞内核响应资产 id 重复：${id}`,
            path: ['events', eventIndex],
          });
        }
        outputIds.add(id);
      }
    });
  });

const collisionKernelErrorResponseSchema = z.strictObject({
  ...collisionKernelEnvelopeBase,
  kind: z.literal('error'),
  error: z.strictObject({
    code: collisionKernelErrorCodeSchema,
    eventId: z.string().min(1).max(128).nullable(),
    message: z.string().min(1).max(512),
  }),
});

export const collisionKernelResponseSchema = z.discriminatedUnion('kind', [
  collisionKernelSuccessResponseSchema,
  collisionKernelErrorResponseSchema,
]);

export type CollisionKernelBatchRequest = z.infer<typeof collisionKernelBatchRequestSchema>;
export type CollisionKernelEventRequest = z.infer<typeof collisionKernelEventRequestSchema>;
export type CollisionKernelEventResolution = z.infer<typeof collisionKernelEventResolutionSchema>;
export type CollisionKernelResponse = z.infer<typeof collisionKernelResponseSchema>;
export type BlackHoleAccretionLedger = z.infer<typeof blackHoleAccretionLedgerSchema>;
export type CollisionKernelErrorCode = z.infer<typeof collisionKernelErrorCodeSchema>;
