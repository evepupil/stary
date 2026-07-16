import { bodyStateSchema, type BodyState } from '../../physics/protocol/schemas';

export function createTestBodyState(overrides: Partial<BodyState> = {}): BodyState {
  const defaultBody: BodyState = {
    id: 'test-body',
    massKg: 1,
    radiusMeters: 1,
    positionMeters: { x: 0, y: 0, z: 0 },
    velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
    spinAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 0 },
    momentOfInertiaFactor: 0.4,
    materialLayers: [{ material: 'silicate', massFraction: 1 }],
    collisionModel: 'gravitySolid',
  };

  return bodyStateSchema.parse({
    ...defaultBody,
    ...overrides,
    positionMeters: {
      ...defaultBody.positionMeters,
      ...overrides.positionMeters,
    },
    velocityMetersPerSecond: {
      ...defaultBody.velocityMetersPerSecond,
      ...overrides.velocityMetersPerSecond,
    },
    spinAngularMomentumKgMetersSquaredPerSecond: {
      ...defaultBody.spinAngularMomentumKgMetersSquaredPerSecond,
      ...overrides.spinAngularMomentumKgMetersSquaredPerSecond,
    },
    materialLayers: (overrides.materialLayers ?? defaultBody.materialLayers).map((layer) => ({
      ...layer,
    })),
  });
}
