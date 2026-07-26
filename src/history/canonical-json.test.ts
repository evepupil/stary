import { describe, expect, it } from 'vitest';

import { canonicalJsonStringify, fnv1a64Hex } from './canonical-json';

describe('canonicalJsonStringify', () => {
  it('对象键按码元升序,数组保持原序', () => {
    expect(canonicalJsonStringify({ b: 1, a: [3, 1, 2], 中: null })).toBe(
      '{"a":[3,1,2],"b":1,"中":null}',
    );
  });

  it('嵌套对象同样规范化,字符串按 JSON 规则转义', () => {
    expect(canonicalJsonStringify({ outer: { z: 'x"y', a: true } })).toBe(
      '{"outer":{"a":true,"z":"x\\"y"}}',
    );
  });

  it('数值使用 JSON 最短往返表示,-0 归一为 0', () => {
    expect(canonicalJsonStringify([-0, 0, 1e308, 5e-324])).toBe('[0,0,1e+308,5e-324]');
    expect(JSON.parse(canonicalJsonStringify(1e308))).toBe(1e308);
    expect(JSON.parse(canonicalJsonStringify(5e-324))).toBe(5e-324);
  });

  it('拒绝非有限数值和不支持的类型', () => {
    expect(() => canonicalJsonStringify(Number.NaN)).toThrow(RangeError);
    expect(() => canonicalJsonStringify(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => canonicalJsonStringify(undefined)).toThrow(TypeError);
    expect(() => canonicalJsonStringify(() => 0)).toThrow(TypeError);
  });
});

describe('fnv1a64Hex', () => {
  it('匹配 FNV-1a 64 公开测试向量', () => {
    expect(fnv1a64Hex('')).toBe('cbf29ce484222325');
    expect(fnv1a64Hex('a')).toBe('af63dc4c8601ec8c');
  });

  it('对 UTF-8 字节计算,多字节字符稳定', () => {
    expect(fnv1a64Hex('宇宙')).toBe(fnv1a64Hex('宇宙'));
    expect(fnv1a64Hex('宇宙')).not.toBe(fnv1a64Hex('宇宙 '));
  });
});
