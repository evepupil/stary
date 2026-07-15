import { describe, expect, it } from 'vitest';

import { advanceAdaptiveExposure, computeTargetExposure } from './adaptive-exposure';

describe('adaptive exposure', () => {
  it('全景使用基线曝光，恒星降低曝光，暗面与黑洞提高曝光', () => {
    expect(
      computeTargetExposure({
        illuminatedFraction: 0,
        stellarVisibility: 0,
        surfaceKind: null,
        viewMode: 'overview',
      }),
    ).toBe(1.1);
    expect(
      computeTargetExposure({
        illuminatedFraction: 1,
        stellarVisibility: 1,
        surfaceKind: 'star',
        viewMode: 'focus',
      }),
    ).toBe(0.68);
    const daylight = computeTargetExposure({
      illuminatedFraction: 1,
      stellarVisibility: 1,
      surfaceKind: 'rocky',
      viewMode: 'focus',
    });
    const darkSide = computeTargetExposure({
      illuminatedFraction: 0,
      stellarVisibility: 1,
      surfaceKind: 'rocky',
      viewMode: 'focus',
    });
    expect(daylight).toBe(1.02);
    expect(darkSide).toBeGreaterThan(daylight);
    expect(
      computeTargetExposure({
        illuminatedFraction: 0,
        stellarVisibility: 0,
        surfaceKind: 'black-hole',
        viewMode: 'focus',
      }),
    ).toBe(1.38);
  });

  it('降低曝光比提高曝光更快，并保持单调逼近目标', () => {
    const darkened = advanceAdaptiveExposure(1.1, 0.68, 0.1);
    const brightened = advanceAdaptiveExposure(0.68, 1.1, 0.1);
    expect(1.1 - darkened).toBeGreaterThan(brightened - 0.68);
    expect(darkened).toBeGreaterThan(0.68);
    expect(brightened).toBeLessThan(1.1);
    expect(advanceAdaptiveExposure(1, 1, 10)).toBe(1);
    expect(() => advanceAdaptiveExposure(1, 1.1, -1)).toThrow(RangeError);
  });
});
