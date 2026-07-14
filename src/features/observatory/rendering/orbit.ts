import type { BodyState } from '../../../physics/protocol/schemas';
import type { ScenePosition } from './coordinates';

const GRAVITATIONAL_CONSTANT_SI = 6.6743e-11;
const MIN_VECTOR_LENGTH = 1e-12;
const MAX_SUPPORTED_ECCENTRICITY = 0.999_999;

interface Vector3Value {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function sampleOsculatingOrbit(
  primary: BodyState,
  body: BodyState,
  metersToSceneUnit: number,
  segments = 256,
): readonly ScenePosition[] | null {
  if (!Number.isInteger(segments) || segments < 16) {
    throw new RangeError('segments 必须是至少 16 的整数');
  }
  if (!Number.isFinite(metersToSceneUnit) || metersToSceneUnit <= 0) {
    throw new RangeError('metersToSceneUnit 必须是正有限数');
  }

  const relativePosition = subtract(body.positionMeters, primary.positionMeters);
  const relativeVelocity = subtract(body.velocityMetersPerSecond, primary.velocityMetersPerSecond);
  const distanceMeters = length(relativePosition);
  const gravitationalParameter = GRAVITATIONAL_CONSTANT_SI * (primary.massKg + body.massKg);

  if (distanceMeters <= MIN_VECTOR_LENGTH || gravitationalParameter <= 0) {
    return null;
  }

  const angularMomentum = cross(relativePosition, relativeVelocity);
  const angularMomentumLength = length(angularMomentum);
  if (angularMomentumLength <= MIN_VECTOR_LENGTH) {
    return null;
  }

  const eccentricityVector = subtract(
    scale(cross(relativeVelocity, angularMomentum), 1 / gravitationalParameter),
    scale(relativePosition, 1 / distanceMeters),
  );
  const eccentricity = length(eccentricityVector);
  const specificEnergy =
    dot(relativeVelocity, relativeVelocity) / 2 - gravitationalParameter / distanceMeters;

  if (
    !Number.isFinite(eccentricity) ||
    eccentricity >= MAX_SUPPORTED_ECCENTRICITY ||
    specificEnergy >= 0
  ) {
    return null;
  }

  const semiLatusRectum = (angularMomentumLength * angularMomentumLength) / gravitationalParameter;
  const periapsisDirection =
    eccentricity > 1e-9
      ? scale(eccentricityVector, 1 / eccentricity)
      : scale(relativePosition, 1 / distanceMeters);
  const orbitNormal = scale(angularMomentum, 1 / angularMomentumLength);
  const transverseDirection = normalize(cross(orbitNormal, periapsisDirection));
  if (transverseDirection === null) {
    return null;
  }

  const points: ScenePosition[] = [];
  for (let index = 0; index <= segments; index += 1) {
    const trueAnomaly = (index / segments) * Math.PI * 2;
    const radiusMeters = semiLatusRectum / (1 + eccentricity * Math.cos(trueAnomaly));
    const relativePoint = add(
      scale(periapsisDirection, radiusMeters * Math.cos(trueAnomaly)),
      scale(transverseDirection, radiusMeters * Math.sin(trueAnomaly)),
    );
    const absolutePoint = add(primary.positionMeters, relativePoint);
    points.push(scale(absolutePoint, metersToSceneUnit));
  }

  return points;
}

function add(left: Vector3Value, right: Vector3Value): Vector3Value {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtract(left: Vector3Value, right: Vector3Value): Vector3Value {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function scale(vector: Vector3Value, scalar: number): Vector3Value {
  return { x: vector.x * scalar, y: vector.y * scalar, z: vector.z * scalar };
}

function dot(left: Vector3Value, right: Vector3Value): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(left: Vector3Value, right: Vector3Value): Vector3Value {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function length(vector: Vector3Value): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalize(vector: Vector3Value): Vector3Value | null {
  const vectorLength = length(vector);
  return vectorLength > MIN_VECTOR_LENGTH ? scale(vector, 1 / vectorLength) : null;
}
