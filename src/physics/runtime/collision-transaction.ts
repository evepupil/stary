import {
  COLLISION_KERNEL_ABI_VERSION,
  COLLISION_MODEL_VERSION,
  COLLISION_RECONSTRUCTION_VERSION,
  MAX_COLLISION_MAJOR_BODIES,
  MAX_COLLISION_PASSIVE_ASSETS,
  collisionKernelBatchRequestSchema,
  collisionKernelResponseSchema,
  computeCollisionLedger,
  computeContactQuantities,
  createDeterministicCollisionSeed,
  parseCollisionResolutionCandidateForInput,
  type CollisionKernelBatchRequest,
  type CollisionKernelErrorCode,
  type CollisionKernelEventRequest,
  type CollisionKernelEventResolution,
  type CollisionKernelWasm,
  type CollisionLedger,
} from '../collisions';
import { compareUtf8 } from '../collisions/stable-order';
import { advanceCollisionLedgerSummary } from '../protocol/collision-ledger-summary';
import {
  type BodyState,
  type CollisionEvent,
  type PhysicsState,
  type WorkerToMainMessage,
} from '../protocol/schemas';
import type {
  CreatePhysicsSimulation,
  PhysicsContactPair,
  PhysicsSimulation,
} from './physics-simulation';
import { replacePhysicsStateAssets } from './passive-assets';

type CollisionBatchMessage = Extract<WorkerToMainMessage, { type: 'collisionBatchResolved' }>;
type CollisionLedgerDelta = CollisionBatchMessage['ledgerDelta'][number];
type CollisionTransactionErrorCode = Extract<WorkerToMainMessage, { type: 'error' }>['code'];

export class CollisionTransactionError extends Error {
  public constructor(
    public readonly code: CollisionTransactionErrorCode,
    message: string,
    public readonly contactState: PhysicsState,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CollisionTransactionError';
  }
}

export interface CollisionTransactionInput {
  readonly collisionBatchSequence: number;
  readonly contactPairs: readonly PhysicsContactPair[];
  readonly contactState: PhysicsState;
  readonly contactTimeSeconds: number;
  readonly createSimulation: CreatePhysicsSimulation;
  readonly kernel: CollisionKernelWasm;
}

export interface CollisionTransactionResult {
  readonly events: readonly CollisionEvent[];
  readonly ledgerDelta: readonly CollisionLedgerDelta[];
  readonly simulation: PhysicsSimulation;
  readonly state: PhysicsState;
}

function fail(
  code: CollisionTransactionErrorCode,
  message: string,
  contactState: PhysicsState,
  cause?: unknown,
): never {
  throw new CollisionTransactionError(
    code,
    message,
    contactState,
    cause === undefined ? {} : { cause },
  );
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((id) => right.includes(id))
  );
}

function assertIndependentPairs(
  pairs: readonly PhysicsContactPair[],
  contactState: PhysicsState,
): void {
  const ownerByBodyId = new Map<string, string>();
  for (const pair of pairs) {
    const key = `${pair.firstBodyId}\0${pair.secondBodyId}`;
    for (const bodyId of [pair.firstBodyId, pair.secondBodyId]) {
      const owner = ownerByBodyId.get(bodyId);
      if (owner !== undefined) {
        fail(
          'unsupportedSimultaneousContact',
          `同刻接触包含共享天体 ${bodyId}：${owner} 与 ${key}`,
          contactState,
        );
      }
      ownerByBodyId.set(bodyId, key);
    }
  }
}

function bodyById(state: PhysicsState, id: string): BodyState {
  const body = state.majorBodies.find((candidate) => candidate.id === id);
  if (body === undefined) {
    fail('collisionResolutionFailed', `接触 pair 引用了不存在的天体 ${id}`, state);
  }
  return body;
}

function eventId(
  collisionBatchSequence: number,
  contactTimeSeconds: number,
  pair: PhysicsContactPair,
  pairIndex: number,
): string {
  const seed = createDeterministicCollisionSeed({
    eventId: `batch-${String(collisionBatchSequence)}@${contactTimeSeconds.toString()}`,
    firstParentId: pair.firstBodyId,
    secondParentId: pair.secondBodyId,
    fragmentKind: 'major',
    fragmentOrdinal: pairIndex,
  });
  return `event-${seed}`;
}

function expectedMaterialProfile(firstBody: BodyState, secondBody: BodyState) {
  const contact = computeContactQuantities(firstBody, secondBody);
  const target = contact.targetBodyId === firstBody.id ? firstBody : secondBody;
  return target.collisionModel === 'gravityFluid'
    ? ('gravityFluid' as const)
    : ('gravitySolid' as const);
}

function createEventRequest(
  input: CollisionTransactionInput,
  pair: PhysicsContactPair,
  pairIndex: number,
): CollisionKernelEventRequest {
  const firstBody = bodyById(input.contactState, pair.firstBodyId);
  const secondBody = bodyById(input.contactState, pair.secondBodyId);
  const collisionInput = {
    eventId: eventId(input.collisionBatchSequence, input.contactTimeSeconds, pair, pairIndex),
    simulationTimeSeconds: input.contactTimeSeconds,
    firstBody,
    secondBody,
  };
  if (firstBody.collisionModel === 'blackHole' || secondBody.collisionModel === 'blackHole') {
    return { domain: 'blackHoleAccretion', input: collisionInput, expectedMaterialProfile: null };
  }
  return {
    domain: 'classic',
    input: collisionInput,
    expectedMaterialProfile: expectedMaterialProfile(firstBody, secondBody),
  };
}

function createKernelRequest(input: CollisionTransactionInput): CollisionKernelBatchRequest {
  const events = input.contactPairs
    .map((pair, pairIndex) => createEventRequest(input, pair, pairIndex))
    .sort((left, right) => compareUtf8(left.input.eventId, right.input.eventId));
  const participantCount = events.length * 2;
  return collisionKernelBatchRequestSchema.parse({
    abiVersion: COLLISION_KERNEL_ABI_VERSION,
    modelVersion: COLLISION_MODEL_VERSION,
    reconstructionVersion: COLLISION_RECONSTRUCTION_VERSION,
    capacity: {
      majorRemnantSlots:
        MAX_COLLISION_MAJOR_BODIES - input.contactState.majorBodies.length + participantCount,
      passiveAssetSlots:
        MAX_COLLISION_PASSIVE_ASSETS -
        input.contactState.tracers.length -
        input.contactState.dustCohorts.length,
    },
    events,
  });
}

function mapKernelError(code: CollisionKernelErrorCode): CollisionTransactionErrorCode {
  switch (code) {
    case 'collisionCapacityExceeded':
      return 'collisionCapacityExceeded';
    case 'collisionConservationFailed':
      return 'collisionConservationFailed';
    case 'unsupportedStellarCollision':
      return 'unsupportedStellarCollision';
    case 'unsupportedStrengthRegime':
      return 'unsupportedStrengthRegime';
    case 'malformedInput':
    case 'unsupportedCollisionDomain':
    case 'collisionReconstructionFailed':
    case 'collisionNumericalFailure':
    case 'duplicateOutputId':
      return 'collisionResolutionFailed';
  }
}

function requestByEventId(
  request: CollisionKernelBatchRequest,
  eventIdValue: string,
  contactState: PhysicsState,
): CollisionKernelEventRequest {
  const event = request.events.find((candidate) => candidate.input.eventId === eventIdValue);
  if (event === undefined) {
    fail('collisionResolutionFailed', `碰撞内核返回未知事件 ${eventIdValue}`, contactState);
  }
  return event;
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-12 * Math.max(Math.abs(left), Math.abs(right), 1);
}

function validateBlackHoleResolution(
  request: Extract<CollisionKernelEventRequest, { domain: 'blackHoleAccretion' }>,
  resolution: Extract<CollisionKernelEventResolution, { domain: 'blackHoleAccretion' }>,
  contactState: PhysicsState,
): void {
  const { firstBody, secondBody } = request.input;
  const expectedParticipantIds = [firstBody.id, secondBody.id];
  if (!sameIdSet(resolution.participantBodyIds, expectedParticipantIds)) {
    fail('collisionResolutionFailed', '黑洞吞噬响应与原始参与体不一致', contactState);
  }
  const totalMassKg = firstBody.massKg + secondBody.massKg;
  const expectedPosition = {
    x:
      (firstBody.positionMeters.x * firstBody.massKg +
        secondBody.positionMeters.x * secondBody.massKg) /
      totalMassKg,
    y:
      (firstBody.positionMeters.y * firstBody.massKg +
        secondBody.positionMeters.y * secondBody.massKg) /
      totalMassKg,
    z:
      (firstBody.positionMeters.z * firstBody.massKg +
        secondBody.positionMeters.z * secondBody.massKg) /
      totalMassKg,
  };
  const expectedVelocity = {
    x:
      (firstBody.velocityMetersPerSecond.x * firstBody.massKg +
        secondBody.velocityMetersPerSecond.x * secondBody.massKg) /
      totalMassKg,
    y:
      (firstBody.velocityMetersPerSecond.y * firstBody.massKg +
        secondBody.velocityMetersPerSecond.y * secondBody.massKg) /
      totalMassKg,
    z:
      (firstBody.velocityMetersPerSecond.z * firstBody.massKg +
        secondBody.velocityMetersPerSecond.z * secondBody.massKg) /
      totalMassKg,
  };
  const remnant = resolution.remnant;
  const scalarChecks = [
    [remnant.massKg, totalMassKg],
    [remnant.positionMeters.x, expectedPosition.x],
    [remnant.positionMeters.y, expectedPosition.y],
    [remnant.positionMeters.z, expectedPosition.z],
    [remnant.velocityMetersPerSecond.x, expectedVelocity.x],
    [remnant.velocityMetersPerSecond.y, expectedVelocity.y],
    [remnant.velocityMetersPerSecond.z, expectedVelocity.z],
    [resolution.ledger.simulationTimeSeconds, request.input.simulationTimeSeconds],
  ] as const;
  if (scalarChecks.some(([actual, expected]) => !approximatelyEqual(actual, expected))) {
    fail('collisionConservationFailed', '黑洞吞噬响应没有绑定原始二体输入', contactState);
  }
}

function trustedClassicLedger(
  request: Extract<CollisionKernelEventRequest, { domain: 'classic' }>,
  resolution: Extract<CollisionKernelEventResolution, { domain: 'classic' }>,
  contactState: PhysicsState,
): CollisionLedger {
  parseCollisionResolutionCandidateForInput(
    resolution.candidate,
    request.input,
    request.expectedMaterialProfile,
  );
  const ledger = computeCollisionLedger({
    eventId: request.input.eventId,
    simulationTimeSeconds: request.input.simulationTimeSeconds,
    before: {
      majorBodies: [request.input.firstBody, request.input.secondBody],
      tracers: [],
      dustCohorts: [],
    },
    after: resolution.after,
    dissipation: resolution.dissipation,
    participantBodyIds: [request.input.firstBody.id, request.input.secondBody.id],
  });
  if (!ledger.passed) {
    fail(
      'collisionConservationFailed',
      `事件 ${request.input.eventId} 未通过可信守恒复算`,
      contactState,
    );
  }
  return ledger;
}

function createCollisionEvent(
  request: CollisionKernelEventRequest,
  resolution: CollisionKernelEventResolution,
): CollisionEvent {
  const contact = computeContactQuantities(request.input.firstBody, request.input.secondBody);
  if (resolution.domain === 'blackHoleAccretion') {
    return {
      eventId: resolution.eventId,
      modelVersion: resolution.ledger.modelVersion,
      participantBodyIds: resolution.participantBodyIds,
      classification: 'blackHoleAccretion',
      specificImpactEnergyJoulesPerKg: contact.specificImpactEnergyJoulesPerKg,
      disruptionThresholdJoulesPerKg: null,
      normalizedImpactEnergy: null,
      impactAngleRadians: contact.impactAngleRadians,
      modelExtrapolated: true,
      majorRemnantIds: [resolution.remnant.id],
      tracerIds: [],
      dustCohortIds: [],
    };
  }
  const disruption = resolution.candidate.disruption;
  return {
    eventId: resolution.eventId,
    modelVersion: resolution.candidate.modelVersion,
    participantBodyIds: resolution.participantBodyIds,
    classification: resolution.candidate.classification,
    specificImpactEnergyJoulesPerKg: resolution.candidate.contact.specificImpactEnergyJoulesPerKg,
    disruptionThresholdJoulesPerKg: disruption?.disruptionThresholdJoulesPerKg ?? null,
    normalizedImpactEnergy: disruption?.normalizedImpactEnergy ?? null,
    impactAngleRadians: resolution.candidate.contact.impactAngleRadians,
    modelExtrapolated:
      (disruption?.obliquityModelExtrapolated ?? false) ||
      (resolution.candidate.gendaModelExtrapolated ?? false),
    majorRemnantIds: resolution.majorRemnantIds,
    tracerIds: resolution.tracerIds,
    dustCohortIds: resolution.dustCohortIds,
  };
}

function assertCandidateSnapshot(
  expectedBodies: readonly BodyState[],
  simulation: PhysicsSimulation,
  contactTimeSeconds: number,
): ReturnType<PhysicsSimulation['snapshot']> {
  if (simulation.timeSeconds !== contactTimeSeconds) {
    throw new Error('候选 REBOUND 没有保留接触时间');
  }
  const snapshot = simulation.snapshot();
  if (
    !sameIdSet(
      snapshot.bodies.map((body) => body.id),
      expectedBodies.map((body) => body.id),
    )
  ) {
    throw new Error('候选 REBOUND 首帧天体集合不一致');
  }
  const expectedById = new Map(expectedBodies.map((body) => [body.id, body]));
  for (const body of snapshot.bodies) {
    const expected = expectedById.get(body.id);
    if (
      body.massKg !== expected?.massKg ||
      body.radiusMeters !== expected.radiusMeters ||
      body.positionMeters.x !== expected.positionMeters.x ||
      body.positionMeters.y !== expected.positionMeters.y ||
      body.positionMeters.z !== expected.positionMeters.z ||
      body.velocityMetersPerSecond.x !== expected.velocityMetersPerSecond.x ||
      body.velocityMetersPerSecond.y !== expected.velocityMetersPerSecond.y ||
      body.velocityMetersPerSecond.z !== expected.velocityMetersPerSecond.z
    ) {
      throw new Error(`候选 REBOUND 首帧没有保持资产 ${body.id} 的惯性状态`);
    }
  }
  return snapshot;
}

export async function resolveCollisionTransaction(
  input: CollisionTransactionInput,
): Promise<CollisionTransactionResult> {
  if (input.contactPairs.length === 0) {
    fail('collisionResolutionFailed', '碰撞事务缺少接触 pair', input.contactState);
  }
  assertIndependentPairs(input.contactPairs, input.contactState);
  let request: CollisionKernelBatchRequest;
  try {
    request = createKernelRequest(input);
  } catch (cause) {
    fail('collisionResolutionFailed', '碰撞请求未通过运行时校验', input.contactState, cause);
  }

  let response;
  try {
    response = collisionKernelResponseSchema.parse(input.kernel.resolveJson(request));
    if (input.kernel.liveContextCount() !== 0) {
      fail(
        'collisionResolutionFailed',
        'Collision WASM 事务结束后仍有活动上下文',
        input.contactState,
      );
    }
  } catch (cause) {
    if (cause instanceof CollisionTransactionError) {
      throw cause;
    }
    fail(
      'collisionResolutionFailed',
      'Collision WASM 响应未通过严格校验',
      input.contactState,
      cause,
    );
  }
  if (response.kind === 'error') {
    fail(mapKernelError(response.error.code), response.error.message, input.contactState);
  }
  if (
    !sameIdSet(
      response.events.map((event) => event.eventId),
      request.events.map((event) => event.input.eventId),
    )
  ) {
    fail('collisionResolutionFailed', 'Collision WASM 响应事件集合不完整', input.contactState);
  }

  const participantIds = new Set<string>();
  const resultMajorBodies: BodyState[] = [];
  const newTracers = [] as PhysicsState['tracers'][number][];
  const newDustCohorts = [] as PhysicsState['dustCohorts'][number][];
  const events: CollisionEvent[] = [];
  const ledgerDelta: CollisionLedgerDelta[] = [];
  try {
    for (const resolution of response.events) {
      const eventRequest = requestByEventId(request, resolution.eventId, input.contactState);
      if (resolution.domain !== eventRequest.domain) {
        fail(
          'collisionResolutionFailed',
          `事件 ${resolution.eventId} 的碰撞 domain 不一致`,
          input.contactState,
        );
      }
      if (
        !sameIdSet(resolution.participantBodyIds, [
          eventRequest.input.firstBody.id,
          eventRequest.input.secondBody.id,
        ])
      ) {
        fail(
          'collisionResolutionFailed',
          `事件 ${resolution.eventId} 的参与体不一致`,
          input.contactState,
        );
      }
      resolution.participantBodyIds.forEach((id) => participantIds.add(id));
      resultMajorBodies.push(...resolution.after.majorBodies);
      newTracers.push(...resolution.after.tracers);
      newDustCohorts.push(...resolution.after.dustCohorts);
      events.push(createCollisionEvent(eventRequest, resolution));
      if (resolution.domain === 'classic' && eventRequest.domain === 'classic') {
        ledgerDelta.push(trustedClassicLedger(eventRequest, resolution, input.contactState));
      } else if (
        resolution.domain === 'blackHoleAccretion' &&
        eventRequest.domain === 'blackHoleAccretion'
      ) {
        validateBlackHoleResolution(eventRequest, resolution, input.contactState);
        ledgerDelta.push(resolution.ledger);
      }
    }
  } catch (cause) {
    if (cause instanceof CollisionTransactionError) {
      throw cause;
    }
    fail(
      'collisionConservationFailed',
      '碰撞结果未通过 TypeScript 可信复算',
      input.contactState,
      cause,
    );
  }

  const nextMajorBodies = [
    ...input.contactState.majorBodies.filter((body) => !participantIds.has(body.id)),
    ...resultMajorBodies,
  ].sort((left, right) => compareUtf8(left.id, right.id));
  const nextTracers = [...input.contactState.tracers, ...newTracers].sort((left, right) =>
    compareUtf8(left.id, right.id),
  );
  const nextDustCohorts = [...input.contactState.dustCohorts, ...newDustCohorts].sort(
    (left, right) => compareUtf8(left.id, right.id),
  );
  const cumulativeCollisionLedger = advanceCollisionLedgerSummary(
    input.contactState.cumulativeCollisionLedger,
    ledgerDelta,
  );

  let candidateSimulation: PhysicsSimulation | undefined;
  try {
    candidateSimulation = await input.createSimulation(nextMajorBodies, input.contactTimeSeconds, {
      preserveReferenceFrame: true,
    });
    const snapshot = assertCandidateSnapshot(
      nextMajorBodies,
      candidateSimulation,
      input.contactTimeSeconds,
    );
    const state = replacePhysicsStateAssets(
      input.contactState,
      snapshot,
      nextTracers,
      nextDustCohorts,
      cumulativeCollisionLedger,
    );
    return { events, ledgerDelta, simulation: candidateSimulation, state };
  } catch (cause) {
    candidateSimulation?.destroy();
    fail('collisionResolutionFailed', '候选 REBOUND 首帧验收失败', input.contactState, cause);
  }
}
