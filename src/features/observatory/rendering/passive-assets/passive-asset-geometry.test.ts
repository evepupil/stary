import { describe, expect, it } from 'vitest';

import type { PassiveCollisionAsset } from '../../../../physics/protocol/schemas';
import { positionMetersToScene } from '../coordinates';
import {
  allocateVisualDebrisCounts,
  computeDebrisSpreadRadiusMeters,
  createDebrisOffsetsMeters,
  packPassiveAssetPositions,
  packVisualDebrisPositions,
  PASSIVE_ASSET_POINT_CAPACITY,
  VISUAL_DEBRIS_BUDGETS,
  VISUAL_DEBRIS_MAX_PER_COHORT,
  VISUAL_DEBRIS_MIN_PER_COHORT,
  VISUAL_DEBRIS_POOL_CAPACITY,
} from './passive-asset-geometry';

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

describe('packPassiveAssetPositions', () => {
  it('打包结果与场景坐标变换逐点一致', () => {
    const origin = { x: 1_000, y: -2_000, z: 500 };
    const scale = 1e-9;
    const assets = [
      createAsset('tracer-1', 1, { x: 1.5e12, y: 2e11, z: -3e11 }),
      createAsset('tracer-2', 2, { x: -4e11, y: 0, z: 9e11 }),
    ];
    const target = new Float32Array(assets.length * 3);

    const count = packPassiveAssetPositions(assets, scale, origin, target);

    expect(count).toBe(2);
    for (const [index, asset] of assets.entries()) {
      const expected = positionMetersToScene(asset.positionMeters, scale, origin);
      expect(target[index * 3]).toBeCloseTo(expected.x, 5);
      expect(target[index * 3 + 1]).toBeCloseTo(expected.y, 5);
      expect(target[index * 3 + 2]).toBeCloseTo(expected.z, 5);
    }
  });

  it('超出目标缓冲容量时按上限截断', () => {
    const assets = [createAsset('a', 1), createAsset('b', 1), createAsset('c', 1)];
    const target = new Float32Array(2 * 3);
    expect(packPassiveAssetPositions(assets, 1, { x: 0, y: 0, z: 0 }, target)).toBe(2);
  });

  it('拒绝非正缩放系数', () => {
    expect(() =>
      packPassiveAssetPositions([], 0, { x: 0, y: 0, z: 0 }, new Float32Array(0)),
    ).toThrow(RangeError);
  });
});

describe('allocateVisualDebrisCounts', () => {
  it('分配总数不超过预算且完全确定', () => {
    const cohorts = [
      createAsset('dust-1', 1e20),
      createAsset('dust-2', 3e20),
      createAsset('dust-3', 6e20),
    ];
    const first = allocateVisualDebrisCounts(cohorts, 1_000);
    const second = allocateVisualDebrisCounts(cohorts, 1_000);

    expect(first).toEqual(second);
    expect(first.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(1_000);
    expect(first[2] ?? 0).toBeGreaterThanOrEqual(first[1] ?? 0);
    expect(first[1] ?? 0).toBeGreaterThanOrEqual(first[0] ?? 0);
    expect(first.every((count) => count >= VISUAL_DEBRIS_MIN_PER_COHORT)).toBe(true);
  });

  it('单个 cohort 受单团上限约束，不吃满全部预算', () => {
    const counts = allocateVisualDebrisCounts(
      [createAsset('dust-1', 1e20)],
      VISUAL_DEBRIS_POOL_CAPACITY,
    );
    expect(counts).toEqual([VISUAL_DEBRIS_MAX_PER_COHORT]);
  });

  it('预算为零或没有 cohort 时返回零分配', () => {
    expect(allocateVisualDebrisCounts([createAsset('dust-1', 1)], 0)).toEqual([0]);
    expect(allocateVisualDebrisCounts([], 100)).toEqual([]);
  });

  it('cohort 数量超过预算时也不超发', () => {
    const cohorts = Array.from({ length: 10 }, (_, index) =>
      createAsset(`dust-${String(index)}`, index + 1),
    );
    const counts = allocateVisualDebrisCounts(cohorts, 7);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(7);
  });

  it('拒绝负数预算', () => {
    expect(() => allocateVisualDebrisCounts([], -1)).toThrow(RangeError);
  });
});

describe('computeDebrisSpreadRadiusMeters', () => {
  it('质量越大扩散半径越大', () => {
    const small = computeDebrisSpreadRadiusMeters(createAsset('dust-1', 1e15));
    const large = computeDebrisSpreadRadiusMeters(createAsset('dust-2', 1e21));
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
  });
});

describe('createDebrisOffsetsMeters', () => {
  it('相同 cohort id 与数量产生完全一致的偏移', () => {
    const first = createDebrisOffsetsMeters('dust-00ff', 64, 1_000);
    const second = createDebrisOffsetsMeters('dust-00ff', 64, 1_000);
    expect(first).toEqual(second);
  });

  it('不同 cohort id 产生不同采样，且偏移大小有界', () => {
    const spread = 1_000;
    const first = createDebrisOffsetsMeters('dust-a', 32, spread);
    const second = createDebrisOffsetsMeters('dust-b', 32, spread);
    expect(first).not.toEqual(second);
    for (let index = 0; index < 32; index += 1) {
      const magnitude = Math.hypot(
        first[index * 3] ?? 0,
        first[index * 3 + 1] ?? 0,
        first[index * 3 + 2] ?? 0,
      );
      expect(magnitude).toBeLessThanOrEqual(spread * 1.000001);
      expect(magnitude).toBeGreaterThan(0);
    }
  });

  it('拒绝负数数量', () => {
    expect(() => createDebrisOffsetsMeters('dust-a', -1, 1)).toThrow(RangeError);
  });
});

describe('packVisualDebrisPositions', () => {
  it('碎屑位置等于 cohort 位置加确定性偏移后再做场景变换', () => {
    const cohort = createAsset('dust-1', 1e20, { x: 1e12, y: -5e11, z: 2e11 });
    const offsets = createDebrisOffsetsMeters(cohort.id, 8, 1_000);
    const origin = { x: 100, y: 200, z: 300 };
    const scale = 1e-10;
    const target = new Float32Array(8 * 3);

    const written = packVisualDebrisPositions(
      [cohort],
      [8],
      new Map([[cohort.id, offsets]]),
      scale,
      origin,
      target,
    );

    expect(written).toBe(8);
    for (let index = 0; index < 8; index += 1) {
      const expected = positionMetersToScene(
        {
          x: cohort.positionMeters.x + (offsets[index * 3] ?? 0),
          y: cohort.positionMeters.y + (offsets[index * 3 + 1] ?? 0),
          z: cohort.positionMeters.z + (offsets[index * 3 + 2] ?? 0),
        },
        scale,
        origin,
      );
      expect(target[index * 3]).toBeCloseTo(expected.x, 5);
      expect(target[index * 3 + 1]).toBeCloseTo(expected.y, 5);
      expect(target[index * 3 + 2]).toBeCloseTo(expected.z, 5);
    }
  });

  it('缺少偏移缓存的 cohort 会被跳过，容量满时停止写入', () => {
    const first = createAsset('dust-1', 1e20);
    const second = createAsset('dust-2', 1e20);
    const offsets = createDebrisOffsetsMeters(second.id, 4, 100);
    const target = new Float32Array(2 * 3);

    const written = packVisualDebrisPositions(
      [first, second],
      [4, 4],
      new Map([[second.id, offsets]]),
      1,
      { x: 0, y: 0, z: 0 },
      target,
    );
    expect(written).toBe(2);
  });

  it('计数数组长度不匹配时抛出', () => {
    expect(() =>
      packVisualDebrisPositions([], [1], new Map(), 1, { x: 0, y: 0, z: 0 }, new Float32Array(3)),
    ).toThrow(RangeError);
  });
});

describe('容量常量', () => {
  it('点缓冲容量等于物理被动资产上限，视觉碎屑预算不超过池容量', () => {
    expect(PASSIVE_ASSET_POINT_CAPACITY).toBe(10_000);
    expect(VISUAL_DEBRIS_BUDGETS.webgpu).toBeLessThanOrEqual(VISUAL_DEBRIS_POOL_CAPACITY);
    expect(VISUAL_DEBRIS_BUDGETS.webgl2).toBeLessThanOrEqual(VISUAL_DEBRIS_BUDGETS.webgpu);
  });
});
