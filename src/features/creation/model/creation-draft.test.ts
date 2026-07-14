import { describe, expect, it } from 'vitest';

import { ASTRONOMICAL_UNIT_METERS } from '../../../physics/constants';
import { MAX_MAJOR_BODY_COUNT, type BodyState } from '../../../physics/protocol/schemas';
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
  return {
    id,
    massKg,
    radiusMeters: 1,
    positionMeters: { x, y: 0, z: 0 },
    velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
  };
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

    expect(snapshot).toMatchObject({ bodyRevision: 3, simulationTimeSeconds: 120 });
    expect(snapshot.bodies[0]?.positionMeters.x).toBe(0);
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
