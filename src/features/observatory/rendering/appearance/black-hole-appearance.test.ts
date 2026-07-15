import { describe, expect, it } from 'vitest';

import {
  ISOLATED_BLACK_HOLE_PROFILE,
  resolveBlackHoleVisualProfile,
} from './black-hole-appearance';

describe('black hole appearance', () => {
  it('使用真实事件视界和可观察阴影比例，并在无物质数据时不生成吸积盘', () => {
    expect(ISOLATED_BLACK_HOLE_PROFILE.eventHorizonRadiusRatio).toBe(1);
    expect(ISOLATED_BLACK_HOLE_PROFILE.photonSphereRadiusRatio).toBe(1.5);
    expect(ISOLATED_BLACK_HOLE_PROFILE.shadowRadiusRatio).toBeCloseTo(2.598_076, 6);
    expect(ISOLATED_BLACK_HOLE_PROFILE.photonRingRadiusRatio).toBeCloseTo(2.598_076, 6);
    expect(ISOLATED_BLACK_HOLE_PROFILE.observableOuterRadiusRatio).toBeGreaterThan(
      ISOLATED_BLACK_HOLE_PROFILE.photonRingRadiusRatio,
    );
    expect(ISOLATED_BLACK_HOLE_PROFILE.accretionDisk).toBeNull();
  });

  it('只为黑洞表面提供专属画面参数', () => {
    expect(resolveBlackHoleVisualProfile('black-hole')).toBe(ISOLATED_BLACK_HOLE_PROFILE);
    expect(resolveBlackHoleVisualProfile('rocky')).toBeNull();
  });
});
