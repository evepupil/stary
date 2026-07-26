import type { CollisionEvent } from '../../../physics/protocol/schemas';

export type CollisionClassification = CollisionEvent['classification'];

export const COLLISION_CLASSIFICATION_LABELS: Record<CollisionClassification, string> = {
  merge: '合并',
  grazeAndMerge: '合并',
  hitAndRun: '擦碰',
  partialAccretion: '坑蚀',
  erosion: '剥离',
  catastrophicDisruption: '碎裂',
  superCatastrophicDisruption: '碎裂',
  blackHoleAccretion: '黑洞吞噬',
};

export const COLLISION_CLASSIFICATION_DETAIL_LABELS: Record<CollisionClassification, string> = {
  merge: '完全合并',
  grazeAndMerge: '擦掠后合并',
  hitAndRun: '擦碰分离',
  partialAccretion: '部分吸积',
  erosion: '侵蚀剥离',
  catastrophicDisruption: '灾难性碎裂',
  superCatastrophicDisruption: '超灾难性碎裂',
  blackHoleAccretion: '黑洞吞噬',
};

export const OMITTED_INTERACTION_CLASS_LABELS: Record<string, string> = {
  tracerTracerGravity: 'tracer 间引力',
  tracerDustGravity: 'tracer 与尘埃引力',
  dustDustGravity: '尘埃间引力',
  passiveBackreaction: '被动资产反作用',
};
