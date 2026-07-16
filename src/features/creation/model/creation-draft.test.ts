import { describe, expect, it } from 'vitest';

import { ASTRONOMICAL_UNIT_METERS } from '../../../physics/constants';
import {
  bodyStateSchema,
  MAX_MAJOR_BODY_COUNT,
  type BodyState,
} from '../../../physics/protocol/schemas';
import { createTestBodyState } from '../../../test/fixtures/body-state';
import {
  buildCreationDraft,
  CREATION_PRESETS,
  estimatePreviewDurationSeconds,
  findDominantReferenceBody,
  getCreationCapacityError,
  parseCreatedBodyId,
} from './body-presets';
import { captureCreationSnapshot } from './creation-draft';

function body(id: string, massKg: number, x: number): BodyState {
  return createTestBodyState({
    id,
    massKg,
    positionMeters: { x, y: 0, z: 0 },
  });
}

const placement = {
  phase: 'placed',
  positionMeters: { x: ASTRONOMICAL_UNIT_METERS, y: 0, z: 0 },
  velocityMetersPerSecond: { x: 0, y: 29_780, z: 0 },
} as const;

describe('creation draft', () => {
  it('只在暂停时间与天体快照一致时深拷贝正式状态', () => {
    const source = [body('sun', 1.988_47e30, 0)];
    const snapshot = captureCreationSnapshot(source, 3, 120, 120);

    const sourceBody = source[0];
    expect(sourceBody).toBeDefined();
    if (sourceBody === undefined) {
      return;
    }
    sourceBody.positionMeters.x = 42;
    sourceBody.spinAngularMomentumKgMetersSquaredPerSecond.z = 42;
    const sourceLayer = sourceBody.materialLayers[0];
    if (sourceLayer === undefined) {
      throw new Error('测试天体缺少材料层');
    }
    sourceLayer.massFraction = 0.5;

    expect(snapshot).toMatchObject({ bodyRevision: 3, simulationTimeSeconds: 120 });
    expect(snapshot.bodies[0]?.positionMeters.x).toBe(0);
    expect(snapshot.bodies[0]?.spinAngularMomentumKgMetersSquaredPerSecond.z).toBe(0);
    expect(snapshot.bodies[0]?.materialLayers[0]?.massFraction).toBe(1);
    expect(() => captureCreationSnapshot(source, 3, 119, 120)).toThrow('尚未追上');
  });

  it('六类预设均生成稳定唯一 id，小行星群生成独立粒子', () => {
    const snapshot = captureCreationSnapshot([body('sun', 1.988_47e30, 0)], 0, 0, 0);
    const drafts = CREATION_PRESETS.map((preset) =>
      buildCreationDraft(snapshot, preset.id, placement),
    );

    expect(drafts).toHaveLength(6);
    expect(drafts.at(-1)?.bodies).toHaveLength(6);
    expect(new Set(drafts.flatMap((draft) => draft.bodies.map((entry) => entry.id))).size).toBe(11);
    drafts
      .flatMap((draft) => draft.bodies)
      .forEach((entry) => {
        expect(() => bodyStateSchema.parse(entry)).not.toThrow();
      });
    expect(drafts.map((draft) => draft.bodies[0]?.collisionModel)).toEqual([
      'stellar',
      'gravitySolid',
      'gravityFluid',
      'gravitySolid',
      'blackHole',
      'gravitySolid',
    ]);
    expect(drafts[4]?.bodies[0]).toMatchObject({
      collisionModel: 'blackHole',
      materialLayers: [],
      momentOfInertiaFactor: null,
    });
    expect(drafts[0]?.bodies[0]?.spinAngularMomentumKgMetersSquaredPerSecond.z).toBeGreaterThan(0);
    const asteroids = drafts[5]?.bodies ?? [];
    expect(
      asteroids.every((entry) => entry.materialLayers !== drafts[5]?.preset.materialLayers),
    ).toBe(true);
    for (let index = 1; index < asteroids.length; index += 1) {
      expect(asteroids[index]?.materialLayers).not.toBe(asteroids[0]?.materialLayers);
      expect(asteroids[index]?.materialLayers[0]).not.toBe(asteroids[0]?.materialLayers[0]);
      expect(asteroids[index]?.spinAngularMomentumKgMetersSquaredPerSecond).not.toBe(
        asteroids[0]?.spinAngularMomentumKgMetersSquaredPerSecond,
      );
    }
    expect(
      CREATION_PRESETS.map((preset) => ({
        id: preset.id,
        collisionModel: preset.collisionModel,
        momentOfInertiaFactor: preset.momentOfInertiaFactor,
        materials: preset.materialLayers.map((layer) => [layer.material, layer.massFraction]),
      })),
    ).toEqual([
      {
        id: 'star',
        collisionModel: 'stellar',
        momentOfInertiaFactor: 0.07,
        materials: [['gas', 1]],
      },
      {
        id: 'rocky-planet',
        collisionModel: 'gravitySolid',
        momentOfInertiaFactor: 0.3307,
        materials: [
          ['silicate', 0.675],
          ['iron', 0.325],
        ],
      },
      {
        id: 'gas-giant',
        collisionModel: 'gravityFluid',
        momentOfInertiaFactor: 0.254,
        materials: [
          ['gas', 0.9],
          ['ice', 0.06],
          ['silicate', 0.03],
          ['iron', 0.01],
        ],
      },
      {
        id: 'moon',
        collisionModel: 'gravitySolid',
        momentOfInertiaFactor: 0.393,
        materials: [
          ['silicate', 0.98],
          ['iron', 0.02],
        ],
      },
      { id: 'black-hole', collisionModel: 'blackHole', momentOfInertiaFactor: null, materials: [] },
      {
        id: 'asteroid-cluster',
        collisionModel: 'gravitySolid',
        momentOfInertiaFactor: 0.4,
        materials: [
          ['silicate', 0.8],
          ['iron', 0.2],
        ],
      },
    ]);
    expect(parseCreatedBodyId('created-gas-giant-03')).toEqual({
      memberIndex: null,
      ordinal: 3,
      presetId: 'gas-giant',
    });
    expect(parseCreatedBodyId('created-asteroid-cluster-02-member-06')).toEqual({
      memberIndex: 6,
      ordinal: 2,
      presetId: 'asteroid-cluster',
    });
  });

  it('按当前位置的引力加速度选择参考天体', () => {
    const sun = body('sun', 1e30, 0);
    const earth = body('earth', 6e24, ASTRONOMICAL_UNIT_METERS);
    const nearEarth = { x: ASTRONOMICAL_UNIT_METERS + 50_000_000, y: 0, z: 0 };

    expect(findDominantReferenceBody([sun, earth], nearEarth)).toBe(earth);
  });

  it('根据参考天体周期估算预览时长并限制为一年', () => {
    const sun = body('sun', 1.988_47e30, 0);
    const snapshot = captureCreationSnapshot([sun], 0, 0, 0);
    const draft = buildCreationDraft(snapshot, 'rocky-planet', placement);

    expect(estimatePreviewDurationSeconds(snapshot.bodies, draft)).toBeCloseTo(31_558_000, -4);
  });

  it('创建数量超过协议上限时拒绝草稿', () => {
    const fullBodies = Array.from({ length: MAX_MAJOR_BODY_COUNT - 5 }, (_, index) =>
      body(`body-${String(index)}`, 1, index * 10),
    );
    const snapshot = captureCreationSnapshot(fullBodies, 0, 0, 0);

    expect(() => buildCreationDraft(snapshot, 'asteroid-cluster', placement)).toThrow('上限');
  });

  it('容量不足时返回可展示错误，切换为单天体预设后恢复', () => {
    const capacityError = getCreationCapacityError(MAX_MAJOR_BODY_COUNT - 5, 'asteroid-cluster');

    expect(capacityError?.message).toContain('上限');
    expect(getCreationCapacityError(MAX_MAJOR_BODY_COUNT - 5, 'rocky-planet')).toBeNull();
  });
});
