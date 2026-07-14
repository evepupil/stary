import { z } from 'zod';

export const PHYSICS_PROTOCOL_VERSION = 1 as const;
export const MAX_MAJOR_BODY_COUNT = 512 as const;

const finiteNumberSchema = z.number();
const nonNegativeFiniteNumberSchema = finiteNumberSchema.nonnegative();
const positiveFiniteNumberSchema = finiteNumberSchema.positive();

export const sessionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0, 'sessionId 不能为空白');

const bodyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0, '天体 id 不能为空白');

export const positionMetersSchema = z.strictObject({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  z: finiteNumberSchema,
});

export const velocityMetersPerSecondSchema = z.strictObject({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  z: finiteNumberSchema,
});

export const linearMomentumKgMetersPerSecondSchema = z.strictObject({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  z: finiteNumberSchema,
});

export const angularMomentumKgMetersSquaredPerSecondSchema = z.strictObject({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  z: finiteNumberSchema,
});

export const bodyStateSchema = z.strictObject({
  id: bodyIdSchema,
  massKg: positiveFiniteNumberSchema,
  radiusMeters: nonNegativeFiniteNumberSchema,
  positionMeters: positionMetersSchema,
  velocityMetersPerSecond: velocityMetersPerSecondSchema,
});

export const bodyStatesSchema = z
  .array(bodyStateSchema)
  .min(1)
  .max(MAX_MAJOR_BODY_COUNT)
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

export const physicsDiagnosticsSchema = z.strictObject({
  totalEnergyJoules: finiteNumberSchema,
  totalLinearMomentumKgMetersPerSecond: linearMomentumKgMetersPerSecondSchema,
  totalAngularMomentumKgMetersSquaredPerSecond: angularMomentumKgMetersSquaredPerSecondSchema,
});

export const messageEnvelopeSchema = z.strictObject({
  version: z.literal(PHYSICS_PROTOCOL_VERSION),
  sessionId: sessionIdSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  simulationTimeSeconds: nonNegativeFiniteNumberSchema,
});

const initializeCommandSchema = messageEnvelopeSchema.extend({
  type: z.literal('initialize'),
  sequence: z.literal(0),
  simulationTimeSeconds: z.literal(0),
  bodies: bodyStatesSchema,
});

const startCommandSchema = messageEnvelopeSchema.extend({
  type: z.literal('start'),
});

const pauseCommandSchema = messageEnvelopeSchema.extend({
  type: z.literal('pause'),
});

const stepCommandSchema = messageEnvelopeSchema.extend({
  type: z.literal('step'),
  stepSeconds: positiveFiniteNumberSchema,
});

const setTimeScaleCommandSchema = messageEnvelopeSchema.extend({
  type: z.literal('setTimeScale'),
  timeScale: positiveFiniteNumberSchema,
});

const disposeCommandSchema = messageEnvelopeSchema.extend({
  type: z.literal('dispose'),
});

export const mainToWorkerMessageSchema = z.discriminatedUnion('type', [
  initializeCommandSchema,
  startCommandSchema,
  pauseCommandSchema,
  stepCommandSchema,
  setTimeScaleCommandSchema,
  disposeCommandSchema,
]);

const readyResponseSchema = messageEnvelopeSchema.extend({
  type: z.literal('ready'),
  sequence: z.literal(0),
  simulationTimeSeconds: z.literal(0),
});

const stateResponseSchema = messageEnvelopeSchema.extend({
  type: z.literal('state'),
  bodies: bodyStatesSchema,
  diagnostics: physicsDiagnosticsSchema,
});

const statusResponseSchema = messageEnvelopeSchema.extend({
  type: z.literal('status'),
  runState: z.enum(['idle', 'initialized', 'running', 'paused']),
  timeScale: positiveFiniteNumberSchema,
});

const errorResponseSchema = messageEnvelopeSchema.extend({
  type: z.literal('error'),
  code: z.enum([
    'invalidCommand',
    'invalidState',
    'initializationFailed',
    'integrationFailed',
    'internalError',
  ]),
  message: z.string().min(1).max(1_024),
  recoverable: z.boolean(),
});

const disposedResponseSchema = messageEnvelopeSchema.extend({
  type: z.literal('disposed'),
});

export const workerToMainMessageSchema = z.discriminatedUnion('type', [
  readyResponseSchema,
  stateResponseSchema,
  statusResponseSchema,
  errorResponseSchema,
  disposedResponseSchema,
]);

export type PositionMeters = z.infer<typeof positionMetersSchema>;
export type VelocityMetersPerSecond = z.infer<typeof velocityMetersPerSecondSchema>;
export type LinearMomentumKgMetersPerSecond = z.infer<typeof linearMomentumKgMetersPerSecondSchema>;
export type AngularMomentumKgMetersSquaredPerSecond = z.infer<
  typeof angularMomentumKgMetersSquaredPerSecondSchema
>;
export type BodyState = z.infer<typeof bodyStateSchema>;
export type PhysicsDiagnostics = z.infer<typeof physicsDiagnosticsSchema>;
export type PhysicsMessageEnvelope = z.infer<typeof messageEnvelopeSchema>;
export type MainToWorkerMessage = z.infer<typeof mainToWorkerMessageSchema>;
export type WorkerToMainMessage = z.infer<typeof workerToMainMessageSchema>;
