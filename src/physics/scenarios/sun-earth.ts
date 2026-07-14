import type { BodyState } from '../protocol/schemas';
import { ASTRONOMICAL_UNIT_METERS, GRAVITATIONAL_CONSTANT_SI } from '../constants';

export const SUN_MASS_KG = 1.98847e30;
export const EARTH_MASS_KG = 5.9722e24;
export const SUN_RADIUS_METERS = 695_700_000;
export const EARTH_RADIUS_METERS = 6_371_000;
export const SUN_EARTH_TEST_ECCENTRICITY = 0.2;

export { ASTRONOMICAL_UNIT_METERS, GRAVITATIONAL_CONSTANT_SI } from '../constants';

export interface SunEarthScenario {
  readonly bodies: readonly BodyState[];
  readonly eccentricity: number;
  readonly periodSeconds: number;
  readonly semiMajorAxisMeters: number;
}

export function createSunEarthScenario(eccentricity = 0): SunEarthScenario {
  if (!Number.isFinite(eccentricity) || eccentricity < 0 || eccentricity >= 1) {
    throw new RangeError('eccentricity 必须是 [0, 1) 内的有限数');
  }

  const totalMassKg = SUN_MASS_KG + EARTH_MASS_KG;
  const gravitationalParameter = GRAVITATIONAL_CONSTANT_SI * totalMassKg;
  const periapsisMeters = ASTRONOMICAL_UNIT_METERS * (1 - eccentricity);
  const relativeSpeedMetersPerSecond = Math.sqrt(
    (gravitationalParameter * (1 + eccentricity)) / periapsisMeters,
  );
  const sunDistanceMeters = (periapsisMeters * EARTH_MASS_KG) / totalMassKg;
  const earthDistanceMeters = (periapsisMeters * SUN_MASS_KG) / totalMassKg;
  const sunSpeedMetersPerSecond = (relativeSpeedMetersPerSecond * EARTH_MASS_KG) / totalMassKg;
  const earthSpeedMetersPerSecond = (relativeSpeedMetersPerSecond * SUN_MASS_KG) / totalMassKg;
  const periodSeconds =
    2 * Math.PI * Math.sqrt(ASTRONOMICAL_UNIT_METERS ** 3 / gravitationalParameter);

  return {
    bodies: [
      {
        id: 'sun',
        massKg: SUN_MASS_KG,
        radiusMeters: SUN_RADIUS_METERS,
        positionMeters: { x: -sunDistanceMeters, y: 0, z: 0 },
        velocityMetersPerSecond: { x: 0, y: -sunSpeedMetersPerSecond, z: 0 },
      },
      {
        id: 'earth',
        massKg: EARTH_MASS_KG,
        radiusMeters: EARTH_RADIUS_METERS,
        positionMeters: { x: earthDistanceMeters, y: 0, z: 0 },
        velocityMetersPerSecond: { x: 0, y: earthSpeedMetersPerSecond, z: 0 },
      },
    ],
    eccentricity,
    periodSeconds,
    semiMajorAxisMeters: ASTRONOMICAL_UNIT_METERS,
  };
}

export function createCircularSunEarthScenario(): SunEarthScenario {
  return createSunEarthScenario(0);
}

export function createEllipticalSunEarthScenario(): SunEarthScenario {
  return createSunEarthScenario(SUN_EARTH_TEST_ECCENTRICITY);
}
