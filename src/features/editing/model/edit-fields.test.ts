import { describe, expect, it } from 'vitest';

import { ASTRONOMICAL_UNIT_METERS } from '../../../physics/constants';
import type { BodyState } from '../../../physics/protocol/schemas';
import {
  bodyStateToEditFields,
  parseBodyEditFields,
  updateBodyEditField,
  type BodyEditFields,
} from './edit-fields';

const earth: BodyState = {
  id: 'earth',
  massKg: 5.972_2e24,
  radiusMeters: 6_371_000,
  positionMeters: { x: ASTRONOMICAL_UNIT_METERS, y: -0.5 * ASTRONOMICAL_UNIT_METERS, z: 0 },
  velocityMetersPerSecond: { x: 1_000, y: 29_780, z: -500 },
};

describe('body edit fields', () => {
  it('按字段路径更新嵌套输入且保留其他值', () => {
    const fields = bodyStateToEditFields(earth);

    const updated = updateBodyEditField(fields, 'velocityKmPerSecond.y', '42');

    expect(updated.velocityKmPerSecond.y).toBe('42');
    expect(updated.positionAu).toEqual(fields.positionAu);
    expect(fields.velocityKmPerSecond.y).not.toBe('42');
  });

  it('把 SI 状态转换为 kg、km、AU 和 km/s 表单字段', () => {
    expect(bodyStateToEditFields(earth)).toEqual({
      massKg: '5.9722e+24',
      radiusKm: '6371',
      positionAu: { x: '1', y: '-0.5', z: '0' },
      velocityKmPerSecond: { x: '1', y: '29.78', z: '-0.5' },
    });
  });

  it('严格解析全部字段，换算回 SI 并保留原 id', () => {
    const fields: BodyEditFields = {
      massKg: ' 6e24 ',
      radiusKm: '6400',
      positionAu: { x: '1.25', y: '-.5', z: '+2e-3' },
      velocityKmPerSecond: { x: '0', y: '30.5', z: '-1e-2' },
    };

    expect(parseBodyEditFields(earth, fields)).toEqual({
      success: true,
      body: {
        id: 'earth',
        massKg: 6e24,
        radiusMeters: 6_400_000,
        positionMeters: {
          x: 1.25 * ASTRONOMICAL_UNIT_METERS,
          y: -0.5 * ASTRONOMICAL_UNIT_METERS,
          z: 0.002 * ASTRONOMICAL_UNIT_METERS,
        },
        velocityMetersPerSecond: { x: 0, y: 30_500, z: -10 },
      },
    });
  });

  it('未修改的格式化字段可以完整还原原天体', () => {
    expect(parseBodyEditFields(earth, bodyStateToEditFields(earth))).toEqual({
      success: true,
      body: earth,
    });
  });

  it('一次返回空值、非有限数字和范围错误对应的字段信息', () => {
    const fields: BodyEditFields = {
      massKg: '0',
      radiusKm: '-1',
      positionAu: { x: '', y: 'NaN', z: 'Infinity' },
      velocityKmPerSecond: { x: '0x10', y: '1e999', z: '   ' },
    };

    expect(parseBodyEditFields(earth, fields)).toEqual({
      success: false,
      errors: {
        massKg: '质量必须大于 0',
        radiusKm: '半径不能小于 0',
        'positionAu.x': 'X 位置不能为空',
        'positionAu.y': 'Y 位置必须是有限数字',
        'positionAu.z': 'Z 位置必须是有限数字',
        'velocityKmPerSecond.x': 'X 速度必须是有限数字',
        'velocityKmPerSecond.y': 'Y 速度必须是有限数字',
        'velocityKmPerSecond.z': 'Z 速度不能为空',
      },
    });
  });

  it('拒绝单位换算后溢出的有限输入', () => {
    const fields = bodyStateToEditFields(earth);
    const result = parseBodyEditFields(earth, {
      ...fields,
      positionAu: { ...fields.positionAu, x: '1e308' },
    });

    expect(result).toEqual({
      success: false,
      errors: { 'positionAu.x': 'X 位置换算后超出可用范围' },
    });
  });
});
