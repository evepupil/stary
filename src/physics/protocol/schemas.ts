import { z } from 'zod';

import { MAX_COLLISION_MAJOR_BODIES } from '../collisions/model-sources';
import { blackHoleAccretionLedgerSchema } from '../collisions/kernel-schemas';
import { collisionLedgerSchema } from '../collisions/schemas';
import {
  advanceCollisionLedgerSummary,
  collisionLedgerSummaryContains,
  createEmptyCollisionLedgerSummary,
} from './collision-ledger-summary';
import { bodyStatesSchema, collisionEventSchema, physicsStateSchema } from './state-schemas';

export const PHYSICS_PROTOCOL_VERSION = 3 as const;
export const MAX_MAJOR_BODY_COUNT = MAX_COLLISION_MAJOR_BODIES;
export const MAX_TIME_SCALE = 5_400_000 as const;

const finiteNumberSchema = z.number();
const nonNegativeFiniteNumberSchema = finiteNumberSchema.nonnegative();
const positiveFiniteNumberSchema = finiteNumberSchema.positive();
const timeScaleSchema = positiveFiniteNumberSchema.max(MAX_TIME_SCALE);
export const bodyRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveBodyRevisionSchema = bodyRevisionSchema.positive();
export const messageSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const simulationTimeSecondsSchema = nonNegativeFiniteNumberSchema;

export const sessionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0, 'sessionId 不能为空白');

export const messageEnvelopeSchema = z.strictObject({
  version: z.literal(PHYSICS_PROTOCOL_VERSION),
  sessionId: sessionIdSchema,
  sequence: messageSequenceSchema,
  simulationTimeSeconds: simulationTimeSecondsSchema,
});

const workerMessageEnvelopeSchema = messageEnvelopeSchema.extend({
  replyToSequence: messageSequenceSchema.nullable(),
});

const initializeCommandSchema = messageEnvelopeSchema.extend({
  type: z.literal('initialize'),
  sequence: z.literal(0),
  simulationTimeSeconds: z.literal(0),
  bodies: bodyStatesSchema,
});

const startCommandSchema = messageEnvelopeSchema.extend({ type: z.literal('start') });
const pauseCommandSchema = messageEnvelopeSchema.extend({ type: z.literal('pause') });
const stepCommandSchema = messageEnvelopeSchema.extend({
  type: z.literal('step'),
  stepSeconds: positiveFiniteNumberSchema,
});
const setTimeScaleCommandSchema = messageEnvelopeSchema.extend({
  type: z.literal('setTimeScale'),
  timeScale: timeScaleSchema,
});
const replaceBodiesCommandSchema = messageEnvelopeSchema.extend({
  type: z.literal('replaceBodies'),
  expectedBodyRevision: bodyRevisionSchema,
  expectedSimulationTimeSeconds: simulationTimeSecondsSchema,
  bodies: bodyStatesSchema,
});
const disposeCommandSchema = messageEnvelopeSchema.extend({ type: z.literal('dispose') });

export const mainToWorkerMessageSchema = z.discriminatedUnion('type', [
  initializeCommandSchema,
  startCommandSchema,
  pauseCommandSchema,
  stepCommandSchema,
  setTimeScaleCommandSchema,
  replaceBodiesCommandSchema,
  disposeCommandSchema,
]);

const readyResponseSchema = workerMessageEnvelopeSchema.extend({
  type: z.literal('ready'),
  sequence: z.literal(0),
  simulationTimeSeconds: z.literal(0),
  replyToSequence: z.literal(0),
  bodyRevision: z.literal(0),
});

const stateResponseSchema = workerMessageEnvelopeSchema
  .extend({
    type: z.literal('state'),
    bodyRevision: bodyRevisionSchema,
    requestedTargetSimulationTimeSeconds: simulationTimeSecondsSchema,
    state: physicsStateSchema,
  })
  .superRefine((message, context) => {
    if (message.simulationTimeSeconds !== message.requestedTargetSimulationTimeSeconds) {
      context.addIssue({
        code: 'custom',
        message: 'state 必须精确到达请求目标时间',
        path: ['simulationTimeSeconds'],
      });
    }
  });

const bodiesReplacedResponseSchema = workerMessageEnvelopeSchema.extend({
  type: z.literal('bodiesReplaced'),
  replyToSequence: messageSequenceSchema,
  bodyRevision: positiveBodyRevisionSchema,
  state: physicsStateSchema,
});

const statusResponseSchema = workerMessageEnvelopeSchema.extend({
  type: z.literal('status'),
  runState: z.enum(['idle', 'initialized', 'running', 'paused']),
  timeScale: timeScaleSchema,
});

const errorResponseSchema = workerMessageEnvelopeSchema.extend({
  type: z.literal('error'),
  code: z.enum([
    'invalidCommand',
    'invalidState',
    'initializationFailed',
    'bodyRevisionConflict',
    'bodySnapshotConflict',
    'bodyReplacementFailed',
    'integrationFailed',
    'collisionResolutionFailed',
    'collisionConservationFailed',
    'collisionCapacityExceeded',
    'collisionContactSetOverflow',
    'unsupportedSimultaneousContact',
    'unsupportedStrengthRegime',
    'unsupportedStellarCollision',
    'internalError',
  ]),
  message: z.string().min(1).max(1_024),
  recoverable: z.boolean(),
});

const disposedResponseSchema = workerMessageEnvelopeSchema.extend({
  type: z.literal('disposed'),
  replyToSequence: messageSequenceSchema,
});

const collisionBatchResolvedResponseSchema = workerMessageEnvelopeSchema
  .extend({
    type: z.literal('collisionBatchResolved'),
    collisionBatchSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    requestedTargetSimulationTimeSeconds: simulationTimeSecondsSchema,
    contactTimeSeconds: simulationTimeSecondsSchema,
    runState: z.literal('paused'),
    bodyRevisionBefore: bodyRevisionSchema,
    bodyRevisionAfter: positiveBodyRevisionSchema,
    events: z.array(collisionEventSchema).min(1),
    ledgerDelta: z.array(z.union([collisionLedgerSchema, blackHoleAccretionLedgerSchema])).min(1),
    state: physicsStateSchema,
  })
  .superRefine((message, context) => {
    if (message.simulationTimeSeconds !== message.contactTimeSeconds) {
      context.addIssue({
        code: 'custom',
        message: '碰撞批次 envelope 时间必须等于接触时间',
        path: ['simulationTimeSeconds'],
      });
    }
    if (message.contactTimeSeconds > message.requestedTargetSimulationTimeSeconds) {
      context.addIssue({
        code: 'custom',
        message: '碰撞接触时间不能晚于请求目标时间',
        path: ['contactTimeSeconds'],
      });
    }
    if (message.bodyRevisionAfter !== message.bodyRevisionBefore + 1) {
      context.addIssue({
        code: 'custom',
        message: '碰撞批次必须只递增一次天体修订号',
        path: ['bodyRevisionAfter'],
      });
    }

    const eventIds = new Set<string>();
    const eventOwnerByAssetId = new Map<string, string>();
    message.events.forEach((event, index) => {
      if (eventIds.has(event.eventId)) {
        context.addIssue({
          code: 'custom',
          message: `碰撞事件 id 重复：${event.eventId}`,
          path: ['events', index, 'eventId'],
        });
      }
      eventIds.add(event.eventId);
      const ownedIds = new Set([
        ...event.participantBodyIds,
        ...event.majorRemnantIds,
        ...event.tracerIds,
        ...event.dustCohortIds,
      ]);
      ownedIds.forEach((assetId) => {
        const existingOwner = eventOwnerByAssetId.get(assetId);
        if (existingOwner !== undefined && existingOwner !== event.eventId) {
          context.addIssue({
            code: 'custom',
            message: `同一碰撞批次的不同事件不能共享参与体或结果资产：${assetId}`,
            path: ['events', index],
          });
        } else {
          eventOwnerByAssetId.set(assetId, event.eventId);
        }
      });
    });
    const ledgerIds = new Set(message.ledgerDelta.map((ledger) => ledger.eventId));
    if (
      ledgerIds.size !== message.ledgerDelta.length ||
      ledgerIds.size !== eventIds.size ||
      [...eventIds].some((eventId) => !ledgerIds.has(eventId))
    ) {
      context.addIssue({
        code: 'custom',
        message: '碰撞事件与账本增量必须按 eventId 一一对应',
        path: ['ledgerDelta'],
      });
    }
    const eventById = new Map(message.events.map((event) => [event.eventId, event]));
    message.ledgerDelta.forEach((ledger, ledgerIndex) => {
      const event = eventById.get(ledger.eventId);
      if (ledger.simulationTimeSeconds !== message.contactTimeSeconds) {
        context.addIssue({
          code: 'custom',
          message: '碰撞账本时间必须等于批次接触时间',
          path: ['ledgerDelta', ledgerIndex, 'simulationTimeSeconds'],
        });
      }
      if (event !== undefined && ledger.modelVersion !== event.modelVersion) {
        context.addIssue({
          code: 'custom',
          message: '碰撞事件与账本必须使用同一模型版本',
          path: ['ledgerDelta', ledgerIndex, 'modelVersion'],
        });
      }
      if (!ledger.passed) {
        context.addIssue({
          code: 'custom',
          message: '已解决碰撞批次不能包含未通过守恒检查的账本',
          path: ['ledgerDelta', ledgerIndex, 'passed'],
        });
      }
    });

    const majorIds = new Set(message.state.majorBodies.map((body) => body.id));
    const tracerIds = new Set(message.state.tracers.map((asset) => asset.id));
    const dustIds = new Set(message.state.dustCohorts.map((asset) => asset.id));
    message.events.forEach((event, eventIndex) => {
      const groups = [
        ['majorRemnantIds', event.majorRemnantIds, majorIds],
        ['tracerIds', event.tracerIds, tracerIds],
        ['dustCohortIds', event.dustCohortIds, dustIds],
      ] as const;
      for (const [field, ids, availableIds] of groups) {
        ids.forEach((id, idIndex) => {
          if (!availableIds.has(id)) {
            context.addIssue({
              code: 'custom',
              message: `碰撞事件引用了新状态中不存在的资产：${id}`,
              path: ['events', eventIndex, field, idIndex],
            });
          }
        });
      }
    });
    const minimumCumulativeLedger = advanceCollisionLedgerSummary(
      createEmptyCollisionLedgerSummary(),
      message.ledgerDelta,
    );
    if (
      !collisionLedgerSummaryContains(
        message.state.cumulativeCollisionLedger,
        minimumCumulativeLedger,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: '累计碰撞摘要不能小于当前批次的事件数与耗散增量',
        path: ['state', 'cumulativeCollisionLedger'],
      });
    }
  });

export const workerToMainMessageSchema = z.discriminatedUnion('type', [
  readyResponseSchema,
  stateResponseSchema,
  bodiesReplacedResponseSchema,
  statusResponseSchema,
  errorResponseSchema,
  disposedResponseSchema,
  collisionBatchResolvedResponseSchema,
]);

export {
  activeReboundDiagnosticsSchema,
  bodyStateSchema,
  bodyStatesSchema,
  collisionEventSchema,
  cumulativeCollisionLedgerSchema,
  cumulativeOmittedBackreactionSchema,
  layeredPhysicsDiagnosticsSchema,
  physicsDiagnosticsSchema,
  physicsIdentifierSchema,
  physicsStateSchema,
  positionMetersSchema,
  velocityMetersPerSecondSchema,
  type ActiveReboundDiagnostics,
  type AngularMomentumKgMetersSquaredPerSecond,
  type BodyState,
  type CollisionEvent,
  type LinearMomentumKgMetersPerSecond,
  type LayeredPhysicsDiagnostics,
  type PhysicsDiagnostics,
  type PhysicsState,
  type PositionMeters,
  type VelocityMetersPerSecond,
} from './state-schemas';

export type PhysicsMessageEnvelope = z.infer<typeof messageEnvelopeSchema>;
export type MainToWorkerMessage = z.infer<typeof mainToWorkerMessageSchema>;
export type WorkerToMainMessage = z.infer<typeof workerToMainMessageSchema>;
export type PhysicsAdvanceResult = Extract<
  WorkerToMainMessage,
  { type: 'state' | 'collisionBatchResolved' }
>;
