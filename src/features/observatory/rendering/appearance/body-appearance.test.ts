import { describe, expect, it } from 'vitest';

import type { BodyState } from '../../../../physics/protocol/schemas';
import {
  estimateMainSequenceStar,
  kelvinToSrgbHex,
  resolveBodyAppearance,
  selectActiveStellarLightIds,
} from './body-appearance';

const SOLAR_MASS_KG = 1.988_47e30;
const SOLAR_RADIUS_METERS = 696_340_000;

function body(id: string, massKg = 1, radiusMeters = 1): BodyState {
  return {
    id,
    massKg,
    radiusMeters,
    positionMeters: { x: 0, y: 0, z: 0 },
    velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
  };
}

describe('body appearance', () => {
  it('覆盖太阳系六类表面，并保留目录颜色', () => {
    expect(resolveBodyAppearance(body('sun', SOLAR_MASS_KG, SOLAR_RADIUS_METERS))).toMatchObject({
      surfaceKind: 'star',
    });
    expect(resolveBodyAppearance(body('earth'))).toMatchObject({
      baseColor: 0x4d9bd6,
      surfaceKind: 'rocky',
      temperatureKelvin: 288,
    });
    expect(resolveBodyAppearance(body('mercury'))).toMatchObject({
      surfaceKind: 'airless',
    });
    expect(resolveBodyAppearance(body('jupiter'))).toMatchObject({
      surfaceKind: 'gas-giant',
    });
    expect(resolveBodyAppearance(body('uranus'))).toMatchObject({
      surfaceKind: 'ice-giant',
    });
    expect(resolveBodyAppearance(body('moon'))).toMatchObject({
      surfaceKind: 'airless',
    });
    expect(
      resolveBodyAppearance(body('created-black-hole-01', 5 * SOLAR_MASS_KG, 15_000)),
    ).toMatchObject({
      baseColor: 0x020204,
      emissiveIntensity: 0,
      light: null,
      surfaceKind: 'black-hole',
    });
  });

  it('从动态创建 ID 恢复岩石、气态、无气层和恒星外观', () => {
    expect(resolveBodyAppearance(body('created-rocky-planet-02'))).toMatchObject({
      baseColor: 0x70a9d6,
      surfaceKind: 'rocky',
    });
    expect(resolveBodyAppearance(body('created-gas-giant-03'))).toMatchObject({
      baseColor: 0xd7a977,
      surfaceKind: 'gas-giant',
    });
    expect(resolveBodyAppearance(body('created-moon-04'))).toMatchObject({
      surfaceKind: 'airless',
      temperatureKelvin: 250,
    });
    expect(resolveBodyAppearance(body('created-asteroid-cluster-02-member-06'))).toMatchObject({
      surfaceKind: 'airless',
      temperatureKelvin: 180,
    });

    const createdStar = resolveBodyAppearance(
      body('created-star-05', SOLAR_MASS_KG, SOLAR_RADIUS_METERS),
    );
    expect(createdStar.surfaceKind).toBe('star');
    expect(createdStar.light).not.toBeNull();
    expect(createdStar.emissiveColor).toBe(createdStar.baseColor);
  });

  it('未知 ID 使用确定性的无气层回退，物理参数变化不改变结构键', () => {
    const first = resolveBodyAppearance(body('unknown-body', 1, 2));
    const second = resolveBodyAppearance(body('unknown-body', 3, 4));

    expect(first).toMatchObject({
      baseColor: 0x8ba4b3,
      surfaceKind: 'airless',
    });
    expect(second.structureKey).toBe(first.structureKey);
    expect(second.structureSeed).toBe(first.structureSeed);
    expect(resolveBodyAppearance(body('other-body')).structureKey).not.toBe(first.structureKey);
  });

  it('太阳质量和半径得到接近太阳的主序星光度与温度', () => {
    const estimate = estimateMainSequenceStar(SOLAR_MASS_KG, SOLAR_RADIUS_METERS);

    expect(estimate.luminositySolar).toBeCloseTo(1, 12);
    expect(estimate.luminosityWatts).toBeCloseTo(3.828e26, 12);
    expect(estimate.temperatureKelvin).toBeCloseTo(5_772, 8);
  });

  it('极端恒星参数限制在有限可渲染范围', () => {
    const cold = estimateMainSequenceStar(1, 0);
    const hot = estimateMainSequenceStar(1e40, 1);

    expect(cold.luminositySolar).toBeGreaterThanOrEqual(1e-4);
    expect(cold.temperatureKelvin).toBeGreaterThanOrEqual(2_400);
    expect(hot.luminositySolar).toBeLessThanOrEqual(1e6);
    expect(hot.temperatureKelvin).toBeLessThanOrEqual(50_000);
    expect(Number.isFinite(hot.luminosityWatts)).toBe(true);
    expect(() => estimateMainSequenceStar(0, 1)).toThrow('massKg');
    expect(() => estimateMainSequenceStar(1, -1)).toThrow('radiusMeters');
  });

  it('把 Kelvin 稳定转换为 sRGB 十六进制并限制算法温区', () => {
    expect(kelvinToSrgbHex(500)).toBe(kelvinToSrgbHex(1_000));
    expect(kelvinToSrgbHex(100_000)).toBe(kelvinToSrgbHex(40_000));
    expect(kelvinToSrgbHex(5_772)).toBeGreaterThanOrEqual(0);
    expect(kelvinToSrgbHex(5_772)).toBeLessThanOrEqual(0xff_ffff);
    expect(() => kelvinToSrgbHex(Number.NaN)).toThrow('temperatureKelvin');
  });

  it('最多选择四个恒星光源，按质量和 id 稳定排序', () => {
    const bodies = [
      body('created-star-04', 4),
      body('created-star-02', 2),
      body('created-black-hole-01', 100),
      body('sun', 5),
      body('created-star-03', 2),
      body('created-star-01', 1),
    ];

    expect(selectActiveStellarLightIds(bodies)).toEqual([
      'sun',
      'created-star-04',
      'created-star-02',
      'created-star-03',
    ]);
    expect(selectActiveStellarLightIds(bodies.toReversed(), 2)).toEqual(['sun', 'created-star-04']);
    expect(selectActiveStellarLightIds(bodies, 99)).toHaveLength(4);
    expect(selectActiveStellarLightIds(bodies, 0)).toEqual([]);
    expect(() => selectActiveStellarLightIds(bodies, -1)).toThrow('requestedLimit');
  });
});
