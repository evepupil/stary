import { describe, expect, it } from 'vitest';

import { collisionEventSchema } from './state-schemas';

describe('collision event schema', () => {
  it('accepts the dedicated black-hole accretion classification', () => {
    expect(
      collisionEventSchema.parse({
        eventId: 'black-hole-accretion',
        modelVersion: 'stary-deterministic-v1',
        participantBodyIds: ['black-hole', 'planet'],
        classification: 'blackHoleAccretion',
        specificImpactEnergyJoulesPerKg: 1,
        disruptionThresholdJoulesPerKg: null,
        normalizedImpactEnergy: null,
        impactAngleRadians: 0,
        modelExtrapolated: true,
        majorRemnantIds: ['collision-remnant'],
        tracerIds: [],
        dustCohortIds: [],
      }).classification,
    ).toBe('blackHoleAccretion');
  });
});
