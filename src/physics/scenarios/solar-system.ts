import {
  CUBIC_KILOMETERS_TO_CUBIC_METERS,
  GRAVITATIONAL_CONSTANT_SI,
  KILOMETERS_TO_METERS,
} from '../constants';
import type { BodyState } from '../protocol/schemas';
import { centerBodiesOnCenterOfMass } from './center-of-mass';
import { SOLAR_SYSTEM_EPOCH, SOLAR_SYSTEM_HORIZONS_RECORDS } from './solar-system-data';

export interface SolarSystemScenario {
  readonly bodies: readonly BodyState[];
  readonly epoch: typeof SOLAR_SYSTEM_EPOCH;
}

function recordToBody(record: (typeof SOLAR_SYSTEM_HORIZONS_RECORDS)[number]): BodyState {
  return {
    id: record.id,
    massKg: (record.gmKm3PerSecond2 * CUBIC_KILOMETERS_TO_CUBIC_METERS) / GRAVITATIONAL_CONSTANT_SI,
    radiusMeters: record.meanRadiusKm * KILOMETERS_TO_METERS,
    positionMeters: {
      x: record.positionKm[0] * KILOMETERS_TO_METERS,
      y: record.positionKm[1] * KILOMETERS_TO_METERS,
      z: record.positionKm[2] * KILOMETERS_TO_METERS,
    },
    velocityMetersPerSecond: {
      x: record.velocityKmPerSecond[0] * KILOMETERS_TO_METERS,
      y: record.velocityKmPerSecond[1] * KILOMETERS_TO_METERS,
      z: record.velocityKmPerSecond[2] * KILOMETERS_TO_METERS,
    },
  };
}

export function createSolarSystemScenario(): SolarSystemScenario {
  const bodies = SOLAR_SYSTEM_HORIZONS_RECORDS.map(recordToBody);
  return {
    bodies: centerBodiesOnCenterOfMass(bodies),
    epoch: SOLAR_SYSTEM_EPOCH,
  };
}
