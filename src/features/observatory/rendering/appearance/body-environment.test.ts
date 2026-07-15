import { describe, expect, it } from 'vitest';

import { computeCloudPhaseRadians, resolveBodyEnvironmentProfile } from './body-environment';

describe('body environment profile', () => {
  it('只给有明确数据的固定行星配置大气，并给地球配置独立云层', () => {
    expect(resolveBodyEnvironmentProfile('earth')).toMatchObject({
      atmosphereLayers: [{ radiusRatio: 1.012 }, { radiusRatio: 1.026 }],
      clouds: { radiusRatio: 1.008, shadowRadiusRatio: 1.0015 },
    });
    expect(resolveBodyEnvironmentProfile('venus')?.atmosphereLayers).toHaveLength(2);
    expect(resolveBodyEnvironmentProfile('mars')?.atmosphereLayers).toHaveLength(2);
    expect(resolveBodyEnvironmentProfile('moon')).toBeNull();
    expect(resolveBodyEnvironmentProfile('created:rocky-planet:1')).toBeNull();
  });

  it('按模拟时间计算可重复的云相位并在完整周期后回到原位', () => {
    const clouds = resolveBodyEnvironmentProfile('earth')?.clouds;
    if (clouds === null || clouds === undefined) {
      throw new Error('地球缺少云层参数');
    }
    const initial = computeCloudPhaseRadians(clouds, 0);
    const afterHour = computeCloudPhaseRadians(clouds, 3_600);
    const afterPeriod = computeCloudPhaseRadians(clouds, clouds.relativeRotationPeriodSeconds);

    expect(afterHour).toBeGreaterThan(initial);
    expect(afterHour - initial).toBeCloseTo(Math.PI / 60, 8);
    expect(afterPeriod).toBeCloseTo(initial, 12);
    expect(
      computeCloudPhaseRadians(clouds, clouds.relativeRotationPeriodSeconds * 1e9 + 3_600),
    ).toBeCloseTo(afterHour, 6);
    expect(() => computeCloudPhaseRadians(clouds, -1)).toThrow(RangeError);
  });
});
