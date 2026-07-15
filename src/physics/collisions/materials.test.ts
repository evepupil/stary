import { describe, expect, it } from 'vitest';

import {
  computeAbsoluteMaterialMasses,
  materialLayerMasses,
  stripOuterMaterial,
} from './materials';

const layers = [
  { material: 'gas' as const, massFraction: 0.1 },
  { material: 'ice' as const, massFraction: 0.2 },
  { material: 'silicate' as const, massFraction: 0.5 },
  { material: 'iron' as const, massFraction: 0.2 },
];

describe('材料分层', () => {
  it('把最后一层作为浮点余量接收者并保持总质量', () => {
    const masses = materialLayerMasses(3, [
      { material: 'gas', massFraction: 1 / 3 },
      { material: 'silicate', massFraction: 1 / 3 },
      { material: 'iron', massFraction: 1 / 3 },
    ]);
    expect(masses.map((layer) => layer.massKg)).toEqual([1, 1, 1]);
    expect(computeAbsoluteMaterialMasses(100, layers)).toEqual({
      gas: 10,
      ice: 20,
      silicate: 50,
      iron: 20,
    });
  });

  it('从外到内剥离并保留材料去向', () => {
    const result = stripOuterMaterial(100, layers, 35);
    expect(result.ejectedLayers).toEqual([
      { material: 'gas', massKg: 10 },
      { material: 'ice', massKg: 20 },
      { material: 'silicate', massKg: 5 },
    ]);
    expect(result.retainedLayers).toEqual([
      { material: 'silicate', massKg: 45 },
      { material: 'iron', massKg: 20 },
    ]);
    expect(result.ejectedMassKg).toBe(35);
    expect(result.retainedMassKg).toBe(65);
  });

  it('覆盖零剥离、整层边界和全部剥离', () => {
    expect(stripOuterMaterial(100, layers, 0).ejectedLayers).toEqual([]);
    expect(stripOuterMaterial(100, layers, 10).ejectedLayers).toEqual([
      { material: 'gas', massKg: 10 },
    ]);
    expect(stripOuterMaterial(100, layers, 100).retainedLayers).toEqual([]);
  });

  it('拒绝负值、超剥离和非法材料分数', () => {
    expect(() => stripOuterMaterial(100, layers, -1)).toThrow('非负有限数');
    expect(() => stripOuterMaterial(100, layers, 101)).toThrow('不能超过');
    expect(() => materialLayerMasses(100, [{ material: 'iron', massFraction: 0.5 }])).toThrow(
      '必须等于 1',
    );
  });
});
