import { GRAVITATIONAL_CONSTANT_SI } from '../constants';
import type { BodyState, PositionMeters } from '../protocol/schemas';

export interface SweptClosestApproach {
  readonly distanceMeters: number;
  readonly segmentFraction: number;
}

export function computeSweptCollisionFraction(
  firstStart: PositionMeters,
  firstEnd: PositionMeters,
  secondStart: PositionMeters,
  secondEnd: PositionMeters,
  collisionDistanceMeters: number,
): number | null {
  const relativeStart = subtract(firstStart, secondStart);
  const relativeEnd = subtract(firstEnd, secondEnd);
  const relativeDelta = subtract(relativeEnd, relativeStart);
  const startOffset = dot(relativeStart, relativeStart) - collisionDistanceMeters ** 2;
  if (startOffset <= 0) {
    return 0;
  }

  const quadratic = dot(relativeDelta, relativeDelta);
  if (quadratic === 0) {
    return null;
  }
  const linear = 2 * dot(relativeStart, relativeDelta);
  const discriminant = linear ** 2 - 4 * quadratic * startOffset;
  if (discriminant < 0) {
    return null;
  }

  const firstIntersection = (-linear - Math.sqrt(discriminant)) / (2 * quadratic);
  return firstIntersection >= 0 && firstIntersection <= 1 ? firstIntersection : null;
}

export function computeSweptClosestApproach(
  firstStart: PositionMeters,
  firstEnd: PositionMeters,
  secondStart: PositionMeters,
  secondEnd: PositionMeters,
): SweptClosestApproach {
  const relativeStart = subtract(firstStart, secondStart);
  const relativeEnd = subtract(firstEnd, secondEnd);
  const relativeDelta = subtract(relativeEnd, relativeStart);
  const deltaLengthSquared = dot(relativeDelta, relativeDelta);
  const segmentFraction =
    deltaLengthSquared > 0
      ? clamp(-dot(relativeStart, relativeDelta) / deltaLengthSquared, 0, 1)
      : 0;
  const closestRelativePosition = add(relativeStart, scale(relativeDelta, segmentFraction));

  return {
    distanceMeters: length(closestRelativePosition),
    segmentFraction,
  };
}

export function isEscapingReferenceBody(body: BodyState, referenceBody: BodyState): boolean {
  const relativePosition = subtract(body.positionMeters, referenceBody.positionMeters);
  const relativeVelocity = subtract(
    body.velocityMetersPerSecond,
    referenceBody.velocityMetersPerSecond,
  );
  const distanceMeters = length(relativePosition);
  if (distanceMeters === 0) {
    return false;
  }

  const gravitationalParameter = GRAVITATIONAL_CONSTANT_SI * (body.massKg + referenceBody.massKg);
  const specificOrbitalEnergy =
    dot(relativeVelocity, relativeVelocity) / 2 - gravitationalParameter / distanceMeters;
  const outwardRadialVelocity = dot(relativePosition, relativeVelocity) / distanceMeters;

  return specificOrbitalEnergy >= 0 && outwardRadialVelocity > 0;
}

function add(left: PositionMeters, right: PositionMeters): PositionMeters {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtract(left: PositionMeters, right: PositionMeters): PositionMeters {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function scale(vector: PositionMeters, scalar: number): PositionMeters {
  return { x: vector.x * scalar, y: vector.y * scalar, z: vector.z * scalar };
}

function dot(left: PositionMeters, right: PositionMeters): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function length(vector: PositionMeters): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
