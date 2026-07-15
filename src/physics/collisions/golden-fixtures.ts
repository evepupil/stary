import { z } from 'zod';

import fixtureJson from './fixtures/collision-golden-v1.json';

const fixtureNumber = z.number();

const disruptionChainFixtureSchema = z.strictObject({
  combinedRadiusMeters: fixtureNumber.positive(),
  totalMassKg: fixtureNumber.positive(),
  massRatio: fixtureNumber.positive().max(1),
  targetRadiusMeters: fixtureNumber.positive(),
  projectileRadiusMeters: fixtureNumber.positive(),
  impactAngleDegrees: fixtureNumber.nonnegative().max(90),
  expectedCriticalImpactParameter: fixtureNumber.positive().max(1),
  expectedInteractingFraction: fixtureNumber.nonnegative().max(1),
  expectedReducedMassRatio: fixtureNumber.positive(),
  expectedHeadOnThresholdJoulesPerKg: fixtureNumber.positive(),
  expectedObliqueThresholdJoulesPerKg: fixtureNumber.positive(),
  expectedCriticalSpeedMetersPerSecond: fixtureNumber.positive(),
});

const collisionGoldenFixturesSchema = z.strictObject({
  version: z.literal(1),
  specificImpactEnergy: z.array(
    z.strictObject({
      targetMassKg: fixtureNumber.positive(),
      projectileMassKg: fixtureNumber.positive(),
      impactSpeedMetersPerSecond: fixtureNumber.positive(),
      expectedJoulesPerKg: fixtureNumber.nonnegative(),
    }),
  ),
  interactingFraction: z.array(
    z.strictObject({
      massRatio: fixtureNumber.positive().max(1),
      impactParameter: fixtureNumber.nonnegative().max(1),
      expected: fixtureNumber.nonnegative().max(1),
    }),
  ),
  principalDisruption: z.array(
    z.strictObject({
      profile: z.enum(['gravitySolid', 'gravityFluid']),
      combinedRadiusMeters: fixtureNumber.positive(),
      expectedThresholdJoulesPerKg: fixtureNumber.positive(),
      expectedCriticalSpeedMetersPerSecond: fixtureNumber.positive(),
    }),
  ),
  fullDisruptionChain: disruptionChainFixtureSchema,
  highInteractionDisruptionChain: disruptionChainFixtureSchema,
  largestRemnant: z.array(
    z.strictObject({
      normalizedImpactEnergy: fixtureNumber.nonnegative(),
      expectedFraction: fixtureNumber.nonnegative().max(1),
    }),
  ),
  gendaCriticalVelocityRatio: z.array(
    z.strictObject({
      massRatio: fixtureNumber.positive().max(1),
      impactAngleDegrees: fixtureNumber.nonnegative().max(90),
      expected: fixtureNumber.positive(),
    }),
  ),
});

export const COLLISION_GOLDEN_FIXTURES = collisionGoldenFixturesSchema.parse(fixtureJson);
