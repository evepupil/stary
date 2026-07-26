import { describe, expect, it, vi } from 'vitest';

import type { PassiveCollisionAsset } from '../../../../physics/protocol/schemas';
import { PASSIVE_ASSET_POINT_CAPACITY, VISUAL_DEBRIS_BUDGETS } from './passive-asset-geometry';
import {
  createPassiveAssetLayer,
  disposePassiveAssetLayer,
  snapshotPassiveAssetLayer,
  updatePassiveAssetLayer,
} from './passive-asset-layer';

function createAsset(
  id: string,
  massKg: number,
  positionMeters: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
): PassiveCollisionAsset {
  return {
    id,
    massKg,
    positionMeters,
    velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
    materialLayers: [{ material: 'silicate', massFraction: 1 }],
    subgridMechanicalEnergyJoules: 0,
  };
}

const ORIGIN = { x: 0, y: 0, z: 0 };

describe('createPassiveAssetLayer', () => {
  it('创建三个有界 Points 图层并按后端选择碎屑预算', () => {
    const layer = createPassiveAssetLayer('webgl2');

    expect(layer.group.children).toHaveLength(3);
    expect(layer.tracerPoints.geometry.getAttribute('position').count).toBe(
      PASSIVE_ASSET_POINT_CAPACITY,
    );
    expect(layer.dustPoints.geometry.getAttribute('position').count).toBe(
      PASSIVE_ASSET_POINT_CAPACITY,
    );
    expect(layer.debrisPoints.geometry.getAttribute('position').count).toBe(
      VISUAL_DEBRIS_BUDGETS.webgl2,
    );
    expect(layer.debrisBudget).toBe(VISUAL_DEBRIS_BUDGETS.webgl2);
    expect(snapshotPassiveAssetLayer(layer)).toEqual({
      tracerCount: 0,
      dustCohortCount: 0,
      visualDebrisCount: 0,
      pointCapacity: PASSIVE_ASSET_POINT_CAPACITY,
      debrisBudget: VISUAL_DEBRIS_BUDGETS.webgl2,
    });

    disposePassiveAssetLayer(layer);
  });
});

describe('updatePassiveAssetLayer', () => {
  it('写入 tracer、尘埃与视觉碎屑计数并控制可见性', () => {
    const layer = createPassiveAssetLayer('webgpu');
    updatePassiveAssetLayer(layer, {
      tracers: [createAsset('tracer-1', 1, { x: 1, y: 2, z: 3 })],
      dustCohorts: [createAsset('dust-1', 1e20, { x: -1, y: 0, z: 0 })],
      metersToSceneUnit: 1,
      originMeters: ORIGIN,
    });

    expect(layer.tracerCount).toBe(1);
    expect(layer.dustCohortCount).toBe(1);
    expect(layer.visualDebrisCount).toBeGreaterThan(0);
    expect(layer.tracerPoints.visible).toBe(true);
    expect(layer.dustPoints.visible).toBe(true);
    expect(layer.debrisPoints.visible).toBe(true);
    expect(layer.tracerPoints.geometry.drawRange.count).toBe(1);
    expect(layer.debrisPoints.geometry.drawRange.count).toBe(layer.visualDebrisCount);

    updatePassiveAssetLayer(layer, {
      tracers: [],
      dustCohorts: [],
      metersToSceneUnit: 1,
      originMeters: ORIGIN,
    });
    expect(layer.tracerCount).toBe(0);
    expect(layer.visualDebrisCount).toBe(0);
    expect(layer.tracerPoints.visible).toBe(false);
    expect(layer.debrisPoints.visible).toBe(false);

    disposePassiveAssetLayer(layer);
  });

  it('相同输入产生逐位一致的碎屑缓冲，移除 cohort 会清理偏移缓存', () => {
    const layer = createPassiveAssetLayer('webgpu');
    const input = {
      tracers: [],
      dustCohorts: [createAsset('dust-1', 1e20, { x: 5, y: 5, z: 5 })],
      metersToSceneUnit: 1,
      originMeters: ORIGIN,
    };

    updatePassiveAssetLayer(layer, input);
    const firstBuffer = Float32Array.from(
      layer.debrisPoints.geometry.getAttribute('position').array as Float32Array,
    );
    updatePassiveAssetLayer(layer, input);
    const secondBuffer = Float32Array.from(
      layer.debrisPoints.geometry.getAttribute('position').array as Float32Array,
    );
    expect(secondBuffer).toEqual(firstBuffer);
    expect(layer.debrisOffsetCache.has('dust-1')).toBe(true);

    updatePassiveAssetLayer(layer, { ...input, dustCohorts: [] });
    expect(layer.debrisOffsetCache.size).toBe(0);

    disposePassiveAssetLayer(layer);
  });
});

describe('disposePassiveAssetLayer', () => {
  it('释放全部几何与材质，重复调用只释放一次', () => {
    const layer = createPassiveAssetLayer('webgpu');
    const geometryDispose = vi.fn();
    const materialDispose = vi.fn();
    for (const points of [layer.tracerPoints, layer.dustPoints, layer.debrisPoints]) {
      points.geometry.addEventListener('dispose', geometryDispose);
      points.material.addEventListener('dispose', materialDispose);
    }

    disposePassiveAssetLayer(layer);
    disposePassiveAssetLayer(layer);

    expect(geometryDispose).toHaveBeenCalledTimes(3);
    expect(materialDispose).toHaveBeenCalledTimes(3);
    expect(layer.group.children).toHaveLength(0);
  });

  it('释放后的图层拒绝继续更新', () => {
    const layer = createPassiveAssetLayer('webgpu');
    disposePassiveAssetLayer(layer);
    updatePassiveAssetLayer(layer, {
      tracers: [createAsset('tracer-1', 1)],
      dustCohorts: [],
      metersToSceneUnit: 1,
      originMeters: ORIGIN,
    });
    expect(layer.tracerCount).toBe(0);
  });
});
