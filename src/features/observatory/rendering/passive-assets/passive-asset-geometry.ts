import { MAX_COLLISION_PASSIVE_ASSETS } from '../../../../physics/collisions/model-sources';
import type { PassiveCollisionAsset, PositionMeters } from '../../../../physics/protocol/schemas';
import type { RendererBackend } from '../create-renderer';

export const PASSIVE_ASSET_POINT_CAPACITY = MAX_COLLISION_PASSIVE_ASSETS;
export const VISUAL_DEBRIS_POOL_CAPACITY = 50_000;

/**
 * 视觉碎屑只减粒子数、不改物理:WebGL2 后端使用更低的粒子预算,
 * 主要碎块、tracer 与 dust cohort 的呈现在两个后端保持一致。
 */
export const VISUAL_DEBRIS_BUDGETS: Record<RendererBackend, number> = {
  webgpu: VISUAL_DEBRIS_POOL_CAPACITY,
  webgl2: 20_000,
};

export const VISUAL_DEBRIS_MIN_PER_COHORT = 16;
export const VISUAL_DEBRIS_MAX_PER_COHORT = 2_048;
const VISUAL_DEBRIS_NOMINAL_DENSITY_KG_PER_M3 = 2_000;
const VISUAL_DEBRIS_SPREAD_FACTOR = 60;

function assertPositiveFiniteScale(metersToSceneUnit: number): void {
  if (!Number.isFinite(metersToSceneUnit) || metersToSceneUnit <= 0) {
    throw new RangeError('metersToSceneUnit 必须是正有限数');
  }
}

export function packPassiveAssetPositions(
  assets: readonly PassiveCollisionAsset[],
  metersToSceneUnit: number,
  originMeters: PositionMeters,
  target: Float32Array,
): number {
  assertPositiveFiniteScale(metersToSceneUnit);
  const capacity = Math.floor(target.length / 3);
  let written = 0;
  for (const asset of assets) {
    if (written >= capacity) {
      break;
    }
    const position = asset.positionMeters;
    target[written * 3] = (position.x - originMeters.x) * metersToSceneUnit;
    target[written * 3 + 1] = (position.y - originMeters.y) * metersToSceneUnit;
    target[written * 3 + 2] = (position.z - originMeters.z) * metersToSceneUnit;
    written += 1;
  }
  return written;
}

export function allocateVisualDebrisCounts(
  dustCohorts: readonly PassiveCollisionAsset[],
  budget: number,
): readonly number[] {
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new RangeError('budget 必须是非负安全整数');
  }
  const cohortCount = dustCohorts.length;
  if (cohortCount === 0 || budget === 0) {
    return dustCohorts.map(() => 0);
  }

  const minimumPerCohort = Math.min(VISUAL_DEBRIS_MIN_PER_COHORT, Math.floor(budget / cohortCount));
  let remaining = budget - minimumPerCohort * cohortCount;
  const totalMassKg = dustCohorts.reduce((sum, cohort) => sum + cohort.massKg, 0);
  const useEqualWeights = !Number.isFinite(totalMassKg) || totalMassKg <= 0;

  return dustCohorts.map((cohort) => {
    const weight = useEqualWeights ? 1 / cohortCount : cohort.massKg / totalMassKg;
    const extra = Math.min(
      remaining,
      Math.floor(budget * weight),
      VISUAL_DEBRIS_MAX_PER_COHORT - minimumPerCohort,
    );
    remaining -= extra;
    return minimumPerCohort + extra;
  });
}

export function computeDebrisSpreadRadiusMeters(cohort: PassiveCollisionAsset): number {
  const nominalRadiusMeters = Math.cbrt(
    (3 * cohort.massKg) / (4 * Math.PI * VISUAL_DEBRIS_NOMINAL_DENSITY_KG_PER_M3),
  );
  return nominalRadiusMeters * VISUAL_DEBRIS_SPREAD_FACTOR;
}

function hashStringFnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function createSeededRandom(seed: number): () => number {
  let state = seed || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

/**
 * 为一个 dust cohort 生成确定性的碎屑云偏移(米)。相同 cohort ID 与数量
 * 在任何后端、任何帧都会得到完全一致的采样。
 */
export function createDebrisOffsetsMeters(
  cohortId: string,
  count: number,
  spreadRadiusMeters: number,
): Float32Array {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError('count 必须是非负安全整数');
  }
  const random = createSeededRandom(hashStringFnv1a32(cohortId));
  const offsets = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const cosPolar = random() * 2 - 1;
    const sinPolar = Math.sqrt(Math.max(0, 1 - cosPolar * cosPolar));
    const azimuth = random() * Math.PI * 2;
    const radius = spreadRadiusMeters * (0.35 + 0.65 * Math.cbrt(random()));
    offsets[index * 3] = radius * sinPolar * Math.cos(azimuth);
    offsets[index * 3 + 1] = radius * sinPolar * Math.sin(azimuth);
    offsets[index * 3 + 2] = radius * cosPolar;
  }
  return offsets;
}

export function packVisualDebrisPositions(
  dustCohorts: readonly PassiveCollisionAsset[],
  debrisCounts: readonly number[],
  offsetsByCohortId: ReadonlyMap<string, Float32Array>,
  metersToSceneUnit: number,
  originMeters: PositionMeters,
  target: Float32Array,
): number {
  assertPositiveFiniteScale(metersToSceneUnit);
  if (debrisCounts.length !== dustCohorts.length) {
    throw new RangeError('debrisCounts 数量必须与 dustCohorts 一致');
  }
  const capacity = Math.floor(target.length / 3);
  let written = 0;
  for (const [cohortIndex, cohort] of dustCohorts.entries()) {
    const offsets = offsetsByCohortId.get(cohort.id);
    if (offsets === undefined) {
      continue;
    }
    const count = Math.min(debrisCounts[cohortIndex] ?? 0, Math.floor(offsets.length / 3));
    for (let index = 0; index < count && written < capacity; index += 1) {
      const position = cohort.positionMeters;
      target[written * 3] =
        (position.x + (offsets[index * 3] ?? 0) - originMeters.x) * metersToSceneUnit;
      target[written * 3 + 1] =
        (position.y + (offsets[index * 3 + 1] ?? 0) - originMeters.y) * metersToSceneUnit;
      target[written * 3 + 2] =
        (position.z + (offsets[index * 3 + 2] ?? 0) - originMeters.z) * metersToSceneUnit;
      written += 1;
    }
  }
  return written;
}
