import type { CollisionBodySnapshot, MaterialLayer } from './schemas';

const DEFAULT_LAYERS: readonly MaterialLayer[] = [
  { material: 'silicate', massFraction: 0.7 },
  { material: 'iron', massFraction: 0.3 },
];

export interface CollisionBodyTestInput {
  readonly id: string;
  readonly massKg: number;
  readonly radiusMeters: number;
  readonly positionMeters?: CollisionBodySnapshot['positionMeters'];
  readonly velocityMetersPerSecond?: CollisionBodySnapshot['velocityMetersPerSecond'];
  readonly spinAngularMomentumKgMetersSquaredPerSecond?: CollisionBodySnapshot['spinAngularMomentumKgMetersSquaredPerSecond'];
  readonly materialLayers?: readonly MaterialLayer[];
  readonly momentOfInertiaFactor?: number;
}

export function collisionBody(input: CollisionBodyTestInput): CollisionBodySnapshot {
  return {
    id: input.id,
    massKg: input.massKg,
    radiusMeters: input.radiusMeters,
    positionMeters: input.positionMeters ?? { x: 0, y: 0, z: 0 },
    velocityMetersPerSecond: input.velocityMetersPerSecond ?? { x: 0, y: 0, z: 0 },
    spinAngularMomentumKgMetersSquaredPerSecond:
      input.spinAngularMomentumKgMetersSquaredPerSecond ?? { x: 0, y: 0, z: 0 },
    momentOfInertiaFactor: input.momentOfInertiaFactor ?? 0.4,
    materialLayers: [...(input.materialLayers ?? DEFAULT_LAYERS)],
    collisionModel: 'gravitySolid',
  };
}

export function contactBodies(input: {
  readonly targetMassKg: number;
  readonly projectileMassKg: number;
  readonly targetRadiusMeters: number;
  readonly projectileRadiusMeters: number;
  readonly impactSpeedMetersPerSecond: number;
  readonly impactAngleRadians?: number;
}): readonly [CollisionBodySnapshot, CollisionBodySnapshot] {
  const angle = input.impactAngleRadians ?? 0;
  return [
    collisionBody({
      id: 'target',
      massKg: input.targetMassKg,
      radiusMeters: input.targetRadiusMeters,
    }),
    collisionBody({
      id: 'projectile',
      massKg: input.projectileMassKg,
      radiusMeters: input.projectileRadiusMeters,
      positionMeters: {
        x: input.targetRadiusMeters + input.projectileRadiusMeters,
        y: 0,
        z: 0,
      },
      velocityMetersPerSecond: {
        x: -input.impactSpeedMetersPerSecond * Math.cos(angle),
        y: input.impactSpeedMetersPerSecond * Math.sin(angle),
        z: 0,
      },
    }),
  ];
}
