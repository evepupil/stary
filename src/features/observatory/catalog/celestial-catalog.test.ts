import { describe, expect, it } from 'vitest';

import {
  CELESTIAL_CATALOG,
  celestialColorToCss,
  getCelestialCatalogEntry,
} from './celestial-catalog';

describe('celestial catalog', () => {
  it('包含按稳定顺序排列的太阳系十个主要天体', () => {
    expect(CELESTIAL_CATALOG).toHaveLength(10);
    expect(CELESTIAL_CATALOG.map((entry) => entry.id)).toEqual([
      'sun',
      'mercury',
      'venus',
      'earth',
      'moon',
      'mars',
      'jupiter',
      'saturn',
      'uranus',
      'neptune',
    ]);
    expect(new Set(CELESTIAL_CATALOG.map((entry) => entry.id)).size).toBe(10);
    expect(CELESTIAL_CATALOG.map((entry) => entry.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('每个轨道父级都存在且月球归属地球', () => {
    const ids = new Set(CELESTIAL_CATALOG.map((entry) => entry.id));
    for (const entry of CELESTIAL_CATALOG) {
      if (entry.orbitParentId !== null) {
        expect(ids.has(entry.orbitParentId), entry.id).toBe(true);
      }
    }
    expect(getCelestialCatalogEntry('moon')?.orbitParentId).toBe('earth');
  });

  it('提供可复用的六位 CSS 颜色', () => {
    expect(celestialColorToCss(getCelestialCatalogEntry('earth')?.color ?? 0)).toBe('#4d9bd6');
    expect(celestialColorToCss(0)).toBe('#000000');
  });

  it('从稳定 id 恢复用户创建天体的名称、类型和分组', () => {
    expect(getCelestialCatalogEntry('created-black-hole-02')).toMatchObject({
      name: '黑洞 02',
      group: 'compact-object',
      type: '5 倍太阳质量黑洞',
    });
    expect(getCelestialCatalogEntry('created-asteroid-cluster-01-member-04')).toMatchObject({
      name: '小行星 01-04',
      group: 'minor-body',
    });
  });
});
