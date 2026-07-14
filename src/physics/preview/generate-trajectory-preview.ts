import type { BodyState } from '../protocol/schemas';
import type { ReboundSimulation, ReboundSnapshot } from '../rebound/rebound-simulation';
import { computeCenterOfMass, type CenterOfMassState } from '../scenarios/center-of-mass';
import {
  computeSweptClosestApproach,
  computeSweptCollisionFraction,
  isEscapingReferenceBody,
} from './risk';
import {
  ORBIT_PREVIEW_PROTOCOL_VERSION,
  trajectoryPreviewRequestSchema,
  trajectoryPreviewResultSchema,
  type TrajectoryPreviewRequest,
  type TrajectoryPreviewResult,
  type TrajectoryPreviewRisk,
  type TrajectoryPreviewTrack,
} from './schemas';

export type CreateTrajectoryPreviewSimulation = (
  bodies: readonly BodyState[],
) => Promise<ReboundSimulation>;

interface CollisionCandidate {
  readonly bodyId: string;
  readonly otherBodyId: string;
  readonly distanceMeters: number;
  readonly timeSeconds: number;
}

// Extra integration targets follow curved motion more closely while the global cap bounds Worker cost.
const MAX_COLLISION_SUBDIVISIONS_PER_TRACK_SEGMENT = 16;
const MAX_COLLISION_RISK_SAMPLE_COUNT = 4_096;
const MAX_COLLISION_RISK_BODY_SAMPLE_BUDGET =
  MAX_COLLISION_RISK_SAMPLE_COUNT * MAX_COLLISION_SUBDIVISIONS_PER_TRACK_SEGMENT;

export async function generateTrajectoryPreview(
  input: TrajectoryPreviewRequest,
  createSimulation: CreateTrajectoryPreviewSimulation,
): Promise<TrajectoryPreviewResult> {
  const request = trajectoryPreviewRequestSchema.parse(input);
  let simulation: ReboundSimulation | undefined;

  try {
    simulation = await createSimulation(request.bodies);
    const inertialFrameOrigin = computeCenterOfMass(request.bodies);
    const tracks = new Map<string, TrajectoryPreviewTrack['points']>(
      request.draftBodyIds.map((bodyId) => [bodyId, []]),
    );
    const collisionPairs = createCollisionPairs(request.bodies, request.draftBodyIds);
    const collisionSubdivisions = computeCollisionSubdivisionCount(
      request.sampleCount,
      request.bodies.length,
    );
    let closestApproachMeters = Number.POSITIVE_INFINITY;
    let earliestCollision: CollisionCandidate | null = null;
    let previousSnapshot = restoreInertialFrame(simulation.snapshot(), inertialFrameOrigin, 0);
    let previousTimeSeconds = 0;

    const initialBodiesById = mapBodiesById(previousSnapshot.bodies, request.bodies.length);
    appendTrackPoints(tracks, request.draftBodyIds, initialBodiesById, 0);
    for (const pair of collisionPairs) {
      const first = requireBody(initialBodiesById, pair[0]);
      const second = requireBody(initialBodiesById, pair[1]);
      const distanceMeters = Math.hypot(
        first.positionMeters.x - second.positionMeters.x,
        first.positionMeters.y - second.positionMeters.y,
        first.positionMeters.z - second.positionMeters.z,
      );
      closestApproachMeters = Math.min(closestApproachMeters, distanceMeters);
      if (distanceMeters <= first.radiusMeters + second.radiusMeters) {
        earliestCollision ??= {
          bodyId: pair[0],
          otherBodyId: pair[1],
          distanceMeters,
          timeSeconds: 0,
        };
      }
    }

    for (let trackIndex = 1; trackIndex < request.sampleCount; trackIndex += 1) {
      const segmentStartTimeSeconds = previousTimeSeconds;
      const trackTimeSeconds =
        trackIndex === request.sampleCount - 1
          ? request.durationSeconds
          : (request.durationSeconds * trackIndex) / (request.sampleCount - 1);
      let trackSnapshot = previousSnapshot;

      for (let subdivision = 1; subdivision <= collisionSubdivisions; subdivision += 1) {
        const targetTimeSeconds =
          subdivision === collisionSubdivisions
            ? trackTimeSeconds
            : segmentStartTimeSeconds +
              ((trackTimeSeconds - segmentStartTimeSeconds) * subdivision) / collisionSubdivisions;
        simulation.integrateTo(targetTimeSeconds);
        const snapshot = restoreInertialFrame(
          simulation.snapshot(),
          inertialFrameOrigin,
          targetTimeSeconds,
        );
        const bodiesById = mapBodiesById(snapshot.bodies, request.bodies.length);
        const previousBodiesById = mapBodiesById(previousSnapshot.bodies, request.bodies.length);
        for (const pair of collisionPairs) {
          const firstStart = requireBody(previousBodiesById, pair[0]);
          const secondStart = requireBody(previousBodiesById, pair[1]);
          const firstEnd = requireBody(bodiesById, pair[0]);
          const secondEnd = requireBody(bodiesById, pair[1]);
          const approach = computeSweptClosestApproach(
            firstStart.positionMeters,
            firstEnd.positionMeters,
            secondStart.positionMeters,
            secondEnd.positionMeters,
          );
          closestApproachMeters = Math.min(closestApproachMeters, approach.distanceMeters);
          const collisionDistanceMeters = firstEnd.radiusMeters + secondEnd.radiusMeters;
          const collisionFraction =
            approach.distanceMeters <= collisionDistanceMeters
              ? computeSweptCollisionFraction(
                  firstStart.positionMeters,
                  firstEnd.positionMeters,
                  secondStart.positionMeters,
                  secondEnd.positionMeters,
                  collisionDistanceMeters,
                )
              : null;
          const collisionTimeSeconds =
            collisionFraction === null
              ? null
              : previousTimeSeconds + (targetTimeSeconds - previousTimeSeconds) * collisionFraction;
          if (
            collisionTimeSeconds !== null &&
            (earliestCollision === null || collisionTimeSeconds < earliestCollision.timeSeconds)
          ) {
            earliestCollision = {
              bodyId: pair[0],
              otherBodyId: pair[1],
              distanceMeters: approach.distanceMeters,
              timeSeconds: collisionTimeSeconds,
            };
          }
        }

        previousSnapshot = snapshot;
        previousTimeSeconds = targetTimeSeconds;
        trackSnapshot = snapshot;
      }

      appendTrackPoints(
        tracks,
        request.draftBodyIds,
        mapBodiesById(trackSnapshot.bodies, request.bodies.length),
        trackTimeSeconds,
      );
    }

    if (!Number.isFinite(closestApproachMeters)) {
      throw new Error('轨道预览没有产生有效采样');
    }

    const finalBodiesById = mapBodiesById(previousSnapshot.bodies, request.bodies.length);
    const risk = classifyRisk(
      earliestCollision,
      request.draftBodyIds,
      request.referenceBodyId,
      finalBodiesById,
      request.durationSeconds,
    );
    const result = {
      version: ORBIT_PREVIEW_PROTOCOL_VERSION,
      type: 'trajectoryPreviewResult',
      requestId: request.requestId,
      draftRevision: request.draftRevision,
      durationSeconds: request.durationSeconds,
      tracks: request.draftBodyIds.map((bodyId) => ({
        bodyId,
        points: tracks.get(bodyId) ?? [],
      })),
      risk,
      closestApproachMeters,
    } as const;

    return trajectoryPreviewResultSchema.parse(result);
  } finally {
    simulation?.destroy();
  }
}

export function computeCollisionSubdivisionCount(sampleCount: number, bodyCount: number): number {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 2) {
    throw new RangeError('碰撞采样点数必须是至少为 2 的安全整数');
  }
  if (!Number.isSafeInteger(bodyCount) || bodyCount < 1) {
    throw new RangeError('碰撞采样天体数必须是正安全整数');
  }
  const segmentCount = sampleCount - 1;
  const subdivisionsWithinGlobalLimit = Math.floor(
    (MAX_COLLISION_RISK_SAMPLE_COUNT - 1) / segmentCount,
  );
  const subdivisionsWithinBodyBudget = Math.floor(
    MAX_COLLISION_RISK_BODY_SAMPLE_BUDGET / (segmentCount * bodyCount),
  );
  return Math.max(
    1,
    Math.min(
      MAX_COLLISION_SUBDIVISIONS_PER_TRACK_SEGMENT,
      subdivisionsWithinGlobalLimit,
      subdivisionsWithinBodyBudget,
    ),
  );
}

function restoreInertialFrame(
  snapshot: ReboundSnapshot,
  origin: CenterOfMassState,
  timeSeconds: number,
): ReboundSnapshot {
  const originPosition = {
    x: origin.positionMeters.x + origin.velocityMetersPerSecond.x * timeSeconds,
    y: origin.positionMeters.y + origin.velocityMetersPerSecond.y * timeSeconds,
    z: origin.positionMeters.z + origin.velocityMetersPerSecond.z * timeSeconds,
  };

  return {
    ...snapshot,
    bodies: snapshot.bodies.map((body) => ({
      ...body,
      positionMeters: {
        x: body.positionMeters.x + originPosition.x,
        y: body.positionMeters.y + originPosition.y,
        z: body.positionMeters.z + originPosition.z,
      },
      velocityMetersPerSecond: {
        x: body.velocityMetersPerSecond.x + origin.velocityMetersPerSecond.x,
        y: body.velocityMetersPerSecond.y + origin.velocityMetersPerSecond.y,
        z: body.velocityMetersPerSecond.z + origin.velocityMetersPerSecond.z,
      },
    })),
  };
}

function appendTrackPoints(
  tracks: Map<string, TrajectoryPreviewTrack['points']>,
  draftBodyIds: readonly string[],
  bodiesById: ReadonlyMap<string, BodyState>,
  timeSeconds: number,
): void {
  for (const bodyId of draftBodyIds) {
    const body = requireBody(bodiesById, bodyId);
    tracks.get(bodyId)?.push({
      timeSeconds,
      positionMeters: { ...body.positionMeters },
    });
  }
}

function createCollisionPairs(
  bodies: readonly BodyState[],
  draftBodyIds: readonly string[],
): readonly (readonly [draftBodyId: string, otherBodyId: string])[] {
  const draftIds = new Set(draftBodyIds);
  const pairs: [string, string][] = [];

  for (const draftBodyId of draftBodyIds) {
    for (const body of bodies) {
      if (body.id === draftBodyId) {
        continue;
      }
      if (draftIds.has(body.id) && body.id < draftBodyId) {
        continue;
      }
      pairs.push([draftBodyId, body.id]);
    }
  }

  return pairs;
}

function mapBodiesById(
  bodies: readonly BodyState[],
  expectedCount: number,
): ReadonlyMap<string, BodyState> {
  if (bodies.length !== expectedCount) {
    throw new Error(
      `轨道预览天体数量异常：预期 ${String(expectedCount)}，实际 ${String(bodies.length)}`,
    );
  }
  const bodiesById = new Map(bodies.map((body) => [body.id, body]));
  if (bodiesById.size !== expectedCount) {
    throw new Error('轨道预览快照包含重复天体 id');
  }
  return bodiesById;
}

function requireBody(bodiesById: ReadonlyMap<string, BodyState>, bodyId: string): BodyState {
  const body = bodiesById.get(bodyId);
  if (body === undefined) {
    throw new Error(`轨道预览快照缺少天体：${bodyId}`);
  }
  return body;
}

function classifyRisk(
  collision: CollisionCandidate | null,
  draftBodyIds: readonly string[],
  referenceBodyId: string,
  finalBodiesById: ReadonlyMap<string, BodyState>,
  durationSeconds: number,
): TrajectoryPreviewRisk {
  if (collision !== null) {
    return {
      kind: 'collision',
      bodyId: collision.bodyId,
      otherBodyId: collision.otherBodyId,
      timeSeconds: collision.timeSeconds,
    };
  }

  const referenceBody = requireBody(finalBodiesById, referenceBodyId);
  for (const bodyId of draftBodyIds) {
    const body = requireBody(finalBodiesById, bodyId);
    if (isEscapingReferenceBody(body, referenceBody)) {
      return {
        kind: 'escape',
        bodyId,
        otherBodyId: referenceBodyId,
        timeSeconds: durationSeconds,
      };
    }
  }

  return { kind: 'stable', bodyId: null, otherBodyId: null, timeSeconds: null };
}
