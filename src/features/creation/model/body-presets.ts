import {
  ASTRONOMICAL_UNIT_METERS,
  GRAVITATIONAL_CONSTANT_SI,
  JULIAN_DAY_SECONDS,
} from '../../../physics/constants';
import {
  MAX_MAJOR_BODY_COUNT,
  type BodyState,
  type PositionMeters,
} from '../../../physics/protocol/schemas';
import type {
  CreationDraft,
  CreationPlacement,
  CreationPreset,
  CreationPresetId,
  CreationSnapshot,
} from './creation-types';

const SOLAR_MASS_KG = 1.988_47e30;
const SPEED_OF_LIGHT_METERS_PER_SECOND = 299_792_458;
const SOLAR_RADIUS_METERS = 696_340_000;
const EARTH_MASS_KG = 5.972_2e24;
const EARTH_RADIUS_METERS = 6_371_000;
const JUPITER_MASS_KG = 1.898_13e27;
const JUPITER_RADIUS_METERS = 69_911_000;
const MOON_MASS_KG = 7.342e22;
const MOON_RADIUS_METERS = 1_737_400;
const ASTEROID_MASS_KG = 1e19;
const ASTEROID_RADIUS_METERS = 100_000;
const ASTEROID_CLUSTER_SPREAD_METERS = 0.012 * ASTRONOMICAL_UNIT_METERS;
const ASTEROID_VELOCITY_DISPERSION_METERS_PER_SECOND = 18;
const MINIMUM_PREVIEW_DURATION_SECONDS = 6 * 3_600;
const DEFAULT_PREVIEW_DURATION_SECONDS = 30 * JULIAN_DAY_SECONDS;
const MAXIMUM_PREVIEW_DURATION_SECONDS = 365.25 * JULIAN_DAY_SECONDS;

function axialSpinAngularMomentum(
  massKg: number,
  radiusMeters: number,
  momentOfInertiaFactor: number,
  rotationPeriodSeconds: number,
): BodyState['spinAngularMomentumKgMetersSquaredPerSecond'] {
  return {
    x: 0,
    y: 0,
    z: (momentOfInertiaFactor * massKg * radiusMeters ** 2 * 2 * Math.PI) / rotationPeriodSeconds,
  };
}

export const CREATION_PRESETS = [
  {
    id: 'star',
    label: '恒星',
    typeLabel: '类太阳恒星',
    color: 0xffd27a,
    massKg: SOLAR_MASS_KG,
    radiusMeters: SOLAR_RADIUS_METERS,
    bodyCount: 1,
    spinAngularMomentumKgMetersSquaredPerSecond: axialSpinAngularMomentum(
      SOLAR_MASS_KG,
      SOLAR_RADIUS_METERS,
      0.07,
      25.38 * JULIAN_DAY_SECONDS,
    ),
    momentOfInertiaFactor: 0.07,
    materialLayers: [{ material: 'gas', massFraction: 1 }],
    collisionModel: 'stellar',
  },
  {
    id: 'rocky-planet',
    label: '岩石行星',
    typeLabel: '类地岩石行星',
    color: 0x70a9d6,
    massKg: EARTH_MASS_KG,
    radiusMeters: EARTH_RADIUS_METERS,
    bodyCount: 1,
    spinAngularMomentumKgMetersSquaredPerSecond: axialSpinAngularMomentum(
      EARTH_MASS_KG,
      EARTH_RADIUS_METERS,
      0.3307,
      86_164.0905,
    ),
    momentOfInertiaFactor: 0.3307,
    materialLayers: [
      { material: 'silicate', massFraction: 0.675 },
      { material: 'iron', massFraction: 0.325 },
    ],
    collisionModel: 'gravitySolid',
  },
  {
    id: 'gas-giant',
    label: '气态行星',
    typeLabel: '类木气态巨行星',
    color: 0xd7a977,
    massKg: JUPITER_MASS_KG,
    radiusMeters: JUPITER_RADIUS_METERS,
    bodyCount: 1,
    spinAngularMomentumKgMetersSquaredPerSecond: axialSpinAngularMomentum(
      JUPITER_MASS_KG,
      JUPITER_RADIUS_METERS,
      0.254,
      9.925 * 3_600,
    ),
    momentOfInertiaFactor: 0.254,
    materialLayers: [
      { material: 'gas', massFraction: 0.9 },
      { material: 'ice', massFraction: 0.06 },
      { material: 'silicate', massFraction: 0.03 },
      { material: 'iron', massFraction: 0.01 },
    ],
    collisionModel: 'gravityFluid',
  },
  {
    id: 'moon',
    label: '卫星',
    typeLabel: '岩质天然卫星',
    color: 0xb8b7b2,
    massKg: MOON_MASS_KG,
    radiusMeters: MOON_RADIUS_METERS,
    bodyCount: 1,
    spinAngularMomentumKgMetersSquaredPerSecond: axialSpinAngularMomentum(
      MOON_MASS_KG,
      MOON_RADIUS_METERS,
      0.393,
      27.321_661 * JULIAN_DAY_SECONDS,
    ),
    momentOfInertiaFactor: 0.393,
    materialLayers: [
      { material: 'silicate', massFraction: 0.98 },
      { material: 'iron', massFraction: 0.02 },
    ],
    collisionModel: 'gravitySolid',
  },
  {
    id: 'black-hole',
    label: '黑洞',
    typeLabel: '5 倍太阳质量黑洞',
    color: 0x9f8cff,
    massKg: 5 * SOLAR_MASS_KG,
    radiusMeters:
      (2 * GRAVITATIONAL_CONSTANT_SI * 5 * SOLAR_MASS_KG) / SPEED_OF_LIGHT_METERS_PER_SECOND ** 2,
    bodyCount: 1,
    spinAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 0 },
    momentOfInertiaFactor: null,
    materialLayers: [],
    collisionModel: 'blackHole',
  },
  {
    id: 'asteroid-cluster',
    label: '小行星群',
    typeLabel: '6 颗独立小行星',
    color: 0x9d9488,
    massKg: ASTEROID_MASS_KG,
    radiusMeters: ASTEROID_RADIUS_METERS,
    bodyCount: 6,
    spinAngularMomentumKgMetersSquaredPerSecond: axialSpinAngularMomentum(
      ASTEROID_MASS_KG,
      ASTEROID_RADIUS_METERS,
      0.4,
      5 * 3_600,
    ),
    momentOfInertiaFactor: 0.4,
    materialLayers: [
      { material: 'silicate', massFraction: 0.8 },
      { material: 'iron', massFraction: 0.2 },
    ],
    collisionModel: 'gravitySolid',
  },
] as const satisfies readonly CreationPreset[];

const presetById = new Map<CreationPresetId, CreationPreset>(
  CREATION_PRESETS.map((preset) => [preset.id, preset]),
);

const createdBodyPattern =
  /^created-(star|rocky-planet|gas-giant|moon|black-hole|asteroid-cluster)-(\d+)(?:-member-(\d+))?$/;

export interface CreatedBodyIdentity {
  readonly presetId: CreationPresetId;
  readonly ordinal: number;
  readonly memberIndex: number | null;
}

export function getCreationPreset(presetId: CreationPresetId): CreationPreset {
  const preset = presetById.get(presetId);
  if (preset === undefined) {
    throw new Error(`未知创建预设：${presetId}`);
  }
  return preset;
}

export function getCreationCapacityError(
  currentBodyCount: number,
  presetId: CreationPresetId,
): RangeError | null {
  const preset = getCreationPreset(presetId);
  if (currentBodyCount + preset.bodyCount <= MAX_MAJOR_BODY_COUNT) {
    return null;
  }
  return new RangeError(`创建后会超过 ${String(MAX_MAJOR_BODY_COUNT)} 个主要天体上限`);
}

export function parseCreatedBodyId(bodyId: string): CreatedBodyIdentity | null {
  const match = createdBodyPattern.exec(bodyId);
  if (match === null) {
    return null;
  }
  const presetId = match[1] as CreationPresetId;
  const ordinal = Number(match[2]);
  const memberIndex = match[3] === undefined ? null : Number(match[3]);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    return null;
  }
  if (memberIndex !== null && (!Number.isSafeInteger(memberIndex) || memberIndex < 1)) {
    return null;
  }
  return { presetId, ordinal, memberIndex };
}

function findNextOrdinal(bodies: readonly BodyState[], presetId: CreationPresetId): number {
  let largestOrdinal = 0;
  for (const body of bodies) {
    const identity = parseCreatedBodyId(body.id);
    if (identity?.presetId === presetId) {
      largestOrdinal = Math.max(largestOrdinal, identity.ordinal);
    }
  }
  return largestOrdinal + 1;
}

function createBodyId(presetId: CreationPresetId, ordinal: number, memberIndex?: number): string {
  const baseId = `created-${presetId}-${String(ordinal).padStart(2, '0')}`;
  return memberIndex === undefined
    ? baseId
    : `${baseId}-member-${String(memberIndex).padStart(2, '0')}`;
}

function vectorDistance(left: PositionMeters, right: PositionMeters): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

export function findDominantReferenceBody(
  bodies: readonly BodyState[],
  positionMeters: PositionMeters,
): BodyState | null {
  let dominantBody: BodyState | null = null;
  let dominantAcceleration = Number.NEGATIVE_INFINITY;

  for (const body of bodies) {
    const distanceMeters = vectorDistance(body.positionMeters, positionMeters);
    const effectiveDistanceMeters = Math.max(distanceMeters, body.radiusMeters, 1);
    const acceleration =
      (GRAVITATIONAL_CONSTANT_SI * body.massKg) /
      (effectiveDistanceMeters * effectiveDistanceMeters);
    if (acceleration > dominantAcceleration) {
      dominantAcceleration = acceleration;
      dominantBody = body;
    }
  }

  return dominantBody;
}

function createSingleBody(
  id: string,
  preset: CreationPreset,
  placement: CreationPlacement,
): BodyState {
  return {
    id,
    massKg: preset.massKg,
    radiusMeters: preset.radiusMeters,
    positionMeters: { ...placement.positionMeters },
    velocityMetersPerSecond: { ...placement.velocityMetersPerSecond },
    spinAngularMomentumKgMetersSquaredPerSecond: {
      ...preset.spinAngularMomentumKgMetersSquaredPerSecond,
    },
    momentOfInertiaFactor: preset.momentOfInertiaFactor,
    materialLayers: preset.materialLayers.map((layer) => ({ ...layer })),
    collisionModel: preset.collisionModel,
  };
}

function createAsteroidCluster(
  ordinal: number,
  preset: CreationPreset,
  placement: CreationPlacement,
): readonly BodyState[] {
  return Array.from({ length: preset.bodyCount }, (_, index) => {
    const angle = (index / preset.bodyCount) * Math.PI * 2;
    const radialFactor = 0.62 + (index % 3) * 0.18;
    const zFactor = ((index % 2) * 2 - 1) * 0.16;
    const offsetMeters = ASTEROID_CLUSTER_SPREAD_METERS * radialFactor;
    const velocityOffset = ASTEROID_VELOCITY_DISPERSION_METERS_PER_SECOND;
    return {
      id: createBodyId(preset.id, ordinal, index + 1),
      massKg: preset.massKg,
      radiusMeters: preset.radiusMeters,
      positionMeters: {
        x: placement.positionMeters.x + Math.cos(angle) * offsetMeters,
        y: placement.positionMeters.y + Math.sin(angle) * offsetMeters,
        z: placement.positionMeters.z + zFactor * ASTEROID_CLUSTER_SPREAD_METERS,
      },
      velocityMetersPerSecond: {
        x: placement.velocityMetersPerSecond.x - Math.sin(angle) * velocityOffset,
        y: placement.velocityMetersPerSecond.y + Math.cos(angle) * velocityOffset,
        z: placement.velocityMetersPerSecond.z + zFactor * velocityOffset * 0.2,
      },
      spinAngularMomentumKgMetersSquaredPerSecond: {
        ...preset.spinAngularMomentumKgMetersSquaredPerSecond,
      },
      momentOfInertiaFactor: preset.momentOfInertiaFactor,
      materialLayers: preset.materialLayers.map((layer) => ({ ...layer })),
      collisionModel: preset.collisionModel,
    };
  });
}

export function buildCreationDraft(
  snapshot: CreationSnapshot,
  presetId: CreationPresetId,
  placement: CreationPlacement,
): CreationDraft {
  const preset = getCreationPreset(presetId);
  const capacityError = getCreationCapacityError(snapshot.bodies.length, presetId);
  if (capacityError !== null) {
    throw capacityError;
  }

  const ordinal = findNextOrdinal(snapshot.bodies, presetId);
  const bodies =
    preset.id === 'asteroid-cluster'
      ? createAsteroidCluster(ordinal, preset, placement)
      : [createSingleBody(createBodyId(preset.id, ordinal), preset, placement)];
  const referenceBody = findDominantReferenceBody(snapshot.bodies, placement.positionMeters);

  return {
    bodies,
    placement,
    preset,
    referenceBodyId: referenceBody?.id ?? null,
  };
}

export function estimatePreviewDurationSeconds(
  snapshotBodies: readonly BodyState[],
  draft: CreationDraft,
): number {
  const candidate = draft.bodies[0];
  if (candidate === undefined) {
    return DEFAULT_PREVIEW_DURATION_SECONDS;
  }

  return estimateBodyPreviewDurationSeconds(snapshotBodies, candidate, draft.referenceBodyId);
}

export function estimateBodyPreviewDurationSeconds(
  snapshotBodies: readonly BodyState[],
  candidate: BodyState,
  referenceBodyId: string | null,
): number {
  const referenceBody = snapshotBodies.find((body) => body.id === referenceBodyId);
  if (referenceBody === undefined) {
    return DEFAULT_PREVIEW_DURATION_SECONDS;
  }

  const distanceMeters = vectorDistance(referenceBody.positionMeters, candidate.positionMeters);
  const gravitationalParameter =
    GRAVITATIONAL_CONSTANT_SI * (referenceBody.massKg + candidate.massKg);
  const estimatedPeriodSeconds =
    2 *
    Math.PI *
    Math.sqrt((distanceMeters * distanceMeters * distanceMeters) / gravitationalParameter);
  if (!Number.isFinite(estimatedPeriodSeconds) || estimatedPeriodSeconds <= 0) {
    return DEFAULT_PREVIEW_DURATION_SECONDS;
  }

  return Math.min(
    MAXIMUM_PREVIEW_DURATION_SECONDS,
    Math.max(MINIMUM_PREVIEW_DURATION_SECONDS, estimatedPeriodSeconds),
  );
}
