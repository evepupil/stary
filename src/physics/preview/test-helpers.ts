import type { BodyState } from '../protocol/schemas';

type PreviewTestBodyOverrides = Partial<Omit<BodyState, 'id'>> & Pick<BodyState, 'id'>;

export function createPreviewTestBody(overrides: PreviewTestBodyOverrides): BodyState {
  return {
    id: overrides.id,
    massKg: overrides.massKg ?? 1,
    radiusMeters: overrides.radiusMeters ?? 1,
    positionMeters: { x: 0, y: 0, z: 0, ...overrides.positionMeters },
    velocityMetersPerSecond: {
      x: 0,
      y: 0,
      z: 0,
      ...overrides.velocityMetersPerSecond,
    },
    spinAngularMomentumKgMetersSquaredPerSecond: {
      x: 0,
      y: 0,
      z: 0,
      ...overrides.spinAngularMomentumKgMetersSquaredPerSecond,
    },
    momentOfInertiaFactor:
      overrides.momentOfInertiaFactor === undefined ? 0.4 : overrides.momentOfInertiaFactor,
    materialLayers: (overrides.materialLayers ?? [{ material: 'silicate', massFraction: 1 }]).map(
      (layer) => ({ ...layer }),
    ),
    collisionModel: overrides.collisionModel ?? 'gravitySolid',
  };
}
