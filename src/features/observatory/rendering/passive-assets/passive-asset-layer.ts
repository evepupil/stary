import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  Points,
  PointsMaterial,
} from 'three';

import type { PassiveCollisionAsset, PositionMeters } from '../../../../physics/protocol/schemas';
import type { RendererBackend } from '../create-renderer';
import {
  allocateVisualDebrisCounts,
  computeDebrisSpreadRadiusMeters,
  createDebrisOffsetsMeters,
  packPassiveAssetPositions,
  packVisualDebrisPositions,
  PASSIVE_ASSET_POINT_CAPACITY,
  VISUAL_DEBRIS_BUDGETS,
} from './passive-asset-geometry';

interface DebrisOffsetCacheEntry {
  readonly count: number;
  readonly offsets: Float32Array;
}

export interface PassiveAssetLayer {
  readonly group: Group;
  readonly tracerPoints: Points<BufferGeometry, PointsMaterial>;
  readonly dustPoints: Points<BufferGeometry, PointsMaterial>;
  readonly debrisPoints: Points<BufferGeometry, PointsMaterial>;
  readonly debrisBudget: number;
  readonly debrisOffsetCache: Map<string, DebrisOffsetCacheEntry>;
  tracerCount: number;
  dustCohortCount: number;
  visualDebrisCount: number;
}

export interface PassiveAssetLayerInput {
  readonly tracers: readonly PassiveCollisionAsset[];
  readonly dustCohorts: readonly PassiveCollisionAsset[];
  readonly metersToSceneUnit: number;
  readonly originMeters: PositionMeters;
}

export interface PassiveAssetLayerSnapshot {
  readonly tracerCount: number;
  readonly dustCohortCount: number;
  readonly visualDebrisCount: number;
  readonly pointCapacity: number;
  readonly debrisBudget: number;
}

const disposedPassiveAssetLayers = new WeakSet<PassiveAssetLayer>();

function createBoundedPoints(
  capacity: number,
  material: PointsMaterial,
): Points<BufferGeometry, PointsMaterial> {
  const geometry = new BufferGeometry();
  const positions = new BufferAttribute(new Float32Array(capacity * 3), 3);
  positions.setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', positions);
  geometry.setDrawRange(0, 0);
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 2;
  return points;
}

export function createPassiveAssetLayer(backend: RendererBackend): PassiveAssetLayer {
  const tracerPoints = createBoundedPoints(
    PASSIVE_ASSET_POINT_CAPACITY,
    new PointsMaterial({
      color: 0x9adcf0,
      depthWrite: false,
      opacity: 0.9,
      size: 3,
      sizeAttenuation: false,
      transparent: true,
    }),
  );
  const dustPoints = createBoundedPoints(
    PASSIVE_ASSET_POINT_CAPACITY,
    new PointsMaterial({
      color: 0xd9b38c,
      depthWrite: false,
      opacity: 0.75,
      size: 2.5,
      sizeAttenuation: false,
      transparent: true,
    }),
  );
  const debrisBudget = VISUAL_DEBRIS_BUDGETS[backend];
  const debrisPoints = createBoundedPoints(
    debrisBudget,
    new PointsMaterial({
      color: 0x8a8f99,
      depthWrite: false,
      opacity: 0.55,
      size: 1.5,
      sizeAttenuation: false,
      transparent: true,
    }),
  );

  const group = new Group();
  group.add(tracerPoints);
  group.add(dustPoints);
  group.add(debrisPoints);

  return {
    group,
    tracerPoints,
    dustPoints,
    debrisPoints,
    debrisBudget,
    debrisOffsetCache: new Map(),
    tracerCount: 0,
    dustCohortCount: 0,
    visualDebrisCount: 0,
  };
}

function writePoints(points: Points<BufferGeometry, PointsMaterial>, count: number): void {
  const attribute = points.geometry.getAttribute('position');
  attribute.needsUpdate = true;
  points.geometry.setDrawRange(0, count);
  points.visible = count > 0;
}

function refreshDebrisOffsets(
  layer: PassiveAssetLayer,
  dustCohorts: readonly PassiveCollisionAsset[],
  debrisCounts: readonly number[],
): void {
  const activeIds = new Set<string>();
  for (const [index, cohort] of dustCohorts.entries()) {
    activeIds.add(cohort.id);
    const count = debrisCounts[index] ?? 0;
    const cached = layer.debrisOffsetCache.get(cohort.id);
    if (cached?.count !== count) {
      layer.debrisOffsetCache.set(cohort.id, {
        count,
        offsets: createDebrisOffsetsMeters(
          cohort.id,
          count,
          computeDebrisSpreadRadiusMeters(cohort),
        ),
      });
    }
  }
  for (const cachedId of layer.debrisOffsetCache.keys()) {
    if (!activeIds.has(cachedId)) {
      layer.debrisOffsetCache.delete(cachedId);
    }
  }
}

export function updatePassiveAssetLayer(
  layer: PassiveAssetLayer,
  input: PassiveAssetLayerInput,
): void {
  if (disposedPassiveAssetLayers.has(layer)) {
    return;
  }
  const { tracers, dustCohorts, metersToSceneUnit, originMeters } = input;

  const tracerAttribute = layer.tracerPoints.geometry.getAttribute('position');
  layer.tracerCount = packPassiveAssetPositions(
    tracers,
    metersToSceneUnit,
    originMeters,
    tracerAttribute.array as Float32Array,
  );
  writePoints(layer.tracerPoints, layer.tracerCount);

  const dustAttribute = layer.dustPoints.geometry.getAttribute('position');
  layer.dustCohortCount = packPassiveAssetPositions(
    dustCohorts,
    metersToSceneUnit,
    originMeters,
    dustAttribute.array as Float32Array,
  );
  writePoints(layer.dustPoints, layer.dustCohortCount);

  const debrisCounts = allocateVisualDebrisCounts(dustCohorts, layer.debrisBudget);
  refreshDebrisOffsets(layer, dustCohorts, debrisCounts);
  const debrisAttribute = layer.debrisPoints.geometry.getAttribute('position');
  const offsetsByCohortId = new Map(
    [...layer.debrisOffsetCache.entries()].map(([id, entry]) => [id, entry.offsets] as const),
  );
  layer.visualDebrisCount = packVisualDebrisPositions(
    dustCohorts,
    debrisCounts,
    offsetsByCohortId,
    metersToSceneUnit,
    originMeters,
    debrisAttribute.array as Float32Array,
  );
  writePoints(layer.debrisPoints, layer.visualDebrisCount);
}

export function snapshotPassiveAssetLayer(layer: PassiveAssetLayer): PassiveAssetLayerSnapshot {
  return {
    tracerCount: layer.tracerCount,
    dustCohortCount: layer.dustCohortCount,
    visualDebrisCount: layer.visualDebrisCount,
    pointCapacity: PASSIVE_ASSET_POINT_CAPACITY,
    debrisBudget: layer.debrisBudget,
  };
}

export function disposePassiveAssetLayer(layer: PassiveAssetLayer): void {
  if (disposedPassiveAssetLayers.has(layer)) {
    return;
  }
  disposedPassiveAssetLayers.add(layer);
  for (const points of [layer.tracerPoints, layer.dustPoints, layer.debrisPoints]) {
    points.geometry.dispose();
    points.material.dispose();
  }
  layer.debrisOffsetCache.clear();
  layer.group.removeFromParent();
  layer.group.clear();
}
