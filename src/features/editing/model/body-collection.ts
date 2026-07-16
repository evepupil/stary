import { GRAVITATIONAL_CONSTANT_SI } from '../../../physics/constants';
import type { BodyState, PositionMeters } from '../../../physics/protocol/schemas';

function cloneBody(body: BodyState): BodyState {
  return {
    ...body,
    positionMeters: { ...body.positionMeters },
    velocityMetersPerSecond: { ...body.velocityMetersPerSecond },
    spinAngularMomentumKgMetersSquaredPerSecond: {
      ...body.spinAngularMomentumKgMetersSquaredPerSecond,
    },
    materialLayers: body.materialLayers.map((layer) => ({ ...layer })),
  };
}

function assertUniqueBodyIds(bodies: readonly BodyState[]): void {
  const ids = new Set<string>();
  for (const body of bodies) {
    if (ids.has(body.id)) {
      throw new Error(`天体 id 重复：${body.id}`);
    }
    ids.add(body.id);
  }
}

export function replaceEditedBody(
  bodies: readonly BodyState[],
  targetBodyId: string,
  replacement: BodyState,
): readonly BodyState[] {
  assertUniqueBodyIds(bodies);
  const targetIndex = bodies.findIndex((body) => body.id === targetBodyId);
  if (targetIndex < 0) {
    throw new Error(`找不到要编辑的天体：${targetBodyId}`);
  }
  if (replacement.id !== targetBodyId) {
    throw new Error(`编辑结果必须保留天体 id：${targetBodyId}`);
  }

  return bodies.map((body, index) => cloneBody(index === targetIndex ? replacement : body));
}

export function deleteBody(
  bodies: readonly BodyState[],
  targetBodyId: string,
): readonly BodyState[] {
  assertUniqueBodyIds(bodies);
  const targetIndex = bodies.findIndex((body) => body.id === targetBodyId);
  if (targetIndex < 0) {
    throw new Error(`找不到要删除的天体：${targetBodyId}`);
  }
  if (bodies.length === 1) {
    throw new RangeError('至少需要保留一个天体');
  }

  return bodies.filter((_, index) => index !== targetIndex).map(cloneBody);
}

function isFinitePosition(position: PositionMeters): boolean {
  return Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
}

function isReasonableBody(body: BodyState): boolean {
  return (
    body.id.trim().length > 0 &&
    Number.isFinite(body.massKg) &&
    body.massKg > 0 &&
    Number.isFinite(body.radiusMeters) &&
    body.radiusMeters >= 0 &&
    isFinitePosition(body.positionMeters)
  );
}

function gravitationalAccelerationAt(body: BodyState, position: PositionMeters): number {
  const distanceMeters = Math.hypot(
    body.positionMeters.x - position.x,
    body.positionMeters.y - position.y,
    body.positionMeters.z - position.z,
  );
  const effectiveDistanceMeters = Math.max(distanceMeters, body.radiusMeters, 1);
  return (
    (GRAVITATIONAL_CONSTANT_SI * body.massKg) / (effectiveDistanceMeters * effectiveDistanceMeters)
  );
}

export function selectFallbackBodyIdAfterDeletion(
  remainingBodies: readonly BodyState[],
  deletedBody: BodyState,
  declaredParentBodyId: string | null,
): string | null {
  if (
    declaredParentBodyId !== null &&
    remainingBodies.some((body) => body.id === declaredParentBodyId)
  ) {
    return declaredParentBodyId;
  }

  if (isFinitePosition(deletedBody.positionMeters)) {
    let dominantBody: BodyState | null = null;
    let dominantAcceleration = Number.NEGATIVE_INFINITY;
    for (const body of remainingBodies) {
      if (!isReasonableBody(body)) {
        continue;
      }
      const acceleration = gravitationalAccelerationAt(body, deletedBody.positionMeters);
      if (Number.isFinite(acceleration) && acceleration > dominantAcceleration) {
        dominantAcceleration = acceleration;
        dominantBody = body;
      }
    }
    if (dominantBody !== null) {
      return dominantBody.id;
    }
  }

  return remainingBodies.find(isReasonableBody)?.id ?? remainingBodies[0]?.id ?? null;
}
