import { GRAVITATIONAL_CONSTANT_SI } from '../constants';
import {
  collisionBodySnapshotSchema,
  contactQuantitiesSchema,
  type CollisionBodySnapshot,
  type ContactQuantities,
} from './schemas';
import { compareUtf8 } from './stable-order';
import { cross, dot, finiteNumber, magnitude, scale, subtract } from './vector';

function normalizeBodies(
  first: CollisionBodySnapshot,
  second: CollisionBodySnapshot,
): { target: CollisionBodySnapshot; projectile: CollisionBodySnapshot } {
  if (first.id === second.id) {
    throw new RangeError('碰撞天体 id 不能相同');
  }
  const firstIsTarget =
    first.massKg > second.massKg ||
    (first.massKg === second.massKg && first.radiusMeters > second.radiusMeters) ||
    (first.massKg === second.massKg &&
      first.radiusMeters === second.radiusMeters &&
      compareUtf8(first.id, second.id) < 0);
  return firstIsTarget
    ? { target: first, projectile: second }
    : { target: second, projectile: first };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function computeContactQuantities(
  firstInput: CollisionBodySnapshot,
  secondInput: CollisionBodySnapshot,
): ContactQuantities {
  const first = collisionBodySnapshotSchema.parse(firstInput);
  const second = collisionBodySnapshotSchema.parse(secondInput);
  const { target, projectile } = normalizeBodies(first, second);
  const relativePosition = subtract(projectile.positionMeters, target.positionMeters);
  const relativeVelocity = subtract(
    projectile.velocityMetersPerSecond,
    target.velocityMetersPerSecond,
  );
  const centerDistanceMeters = magnitude(relativePosition);
  const impactSpeedMetersPerSecond = magnitude(relativeVelocity);
  if (centerDistanceMeters <= 0) {
    throw new RangeError('碰撞天体的中心距离必须大于 0');
  }
  if (impactSpeedMetersPerSecond <= 0) {
    throw new RangeError('碰撞天体的相对速度必须大于 0');
  }

  const radiusSumMeters = finiteNumber(target.radiusMeters + projectile.radiusMeters);
  const coordinateScaleMeters = Math.max(
    radiusSumMeters,
    ...Object.values(target.positionMeters).map(Math.abs),
    ...Object.values(projectile.positionMeters).map(Math.abs),
  );
  const contactDistanceToleranceMeters = Math.max(
    1e-10 * radiusSumMeters,
    64 * Number.EPSILON * coordinateScaleMeters,
  );
  if (centerDistanceMeters > radiusSumMeters + contactDistanceToleranceMeters) {
    throw new RangeError('碰撞快照中的天体尚未接触');
  }
  const relativePositionDirection = scale(relativePosition, 1 / centerDistanceMeters);
  const relativeVelocityDirection = scale(relativeVelocity, 1 / impactSpeedMetersPerSecond);
  if (dot(relativePositionDirection, relativeVelocityDirection) > 0) {
    throw new RangeError('碰撞快照中的天体已经开始分离');
  }

  const totalMassKg = finiteNumber(target.massKg + projectile.massKg);
  const reducedMassKg = finiteNumber(projectile.massKg / (1 + projectile.massKg / target.massKg));
  const massRatio = projectile.massKg / target.massKg;
  const impactParameter = clamp(
    magnitude(cross(relativePositionDirection, relativeVelocityDirection)),
    0,
    1,
  );
  const impactAngleRadians = Math.asin(impactParameter);
  const criticalImpactParameter = target.radiusMeters / radiusSumMeters;
  const interactingLengthMeters = clamp(
    radiusSumMeters * (1 - impactParameter),
    0,
    2 * projectile.radiusMeters,
  );
  const interactingLengthRadiusRatio = interactingLengthMeters / projectile.radiusMeters;
  const interactingProjectileFraction = clamp(
    interactingLengthMeters >= 2 * projectile.radiusMeters
      ? 1
      : (3 * interactingLengthRadiusRatio ** 2 - interactingLengthRadiusRatio ** 3) / 4,
    0,
    1,
  );
  const interactingProjectileMassKg = interactingProjectileFraction * projectile.massKg;
  const interactingReducedMassKg =
    interactingProjectileMassKg > 0
      ? finiteNumber(
          interactingProjectileMassKg / (1 + interactingProjectileMassKg / target.massKg),
        )
      : 0;
  const mutualEscapeSpeedMetersPerSecond = Math.sqrt(
    (2 * GRAVITATIONAL_CONSTANT_SI * totalMassKg) / radiusSumMeters,
  );
  const specificImpactEnergyJoulesPerKg = finiteNumber(
    0.5 * (reducedMassKg / totalMassKg) * impactSpeedMetersPerSecond ** 2,
  );

  return contactQuantitiesSchema.parse({
    targetBodyId: target.id,
    projectileBodyId: projectile.id,
    targetMassKg: target.massKg,
    projectileMassKg: projectile.massKg,
    targetRadiusMeters: target.radiusMeters,
    projectileRadiusMeters: projectile.radiusMeters,
    totalMassKg,
    reducedMassKg,
    interactingReducedMassKg,
    massRatio,
    centerDistanceMeters,
    radiusSumMeters,
    impactSpeedMetersPerSecond,
    mutualEscapeSpeedMetersPerSecond,
    specificImpactEnergyJoulesPerKg,
    impactAngleRadians,
    impactParameter,
    criticalImpactParameter,
    interactingLengthMeters,
    interactingProjectileFraction,
    grazing: impactParameter > criticalImpactParameter,
  });
}
