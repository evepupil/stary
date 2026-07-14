import { describe, expect, it } from 'vitest';

import { resolveBodyRenderingProfile } from './body-rendering';

describe('resolveBodyRenderingProfile', () => {
  it('让太阳和动态创建的恒星各自发光', () => {
    expect(resolveBodyRenderingProfile('sun')).toMatchObject({
      emitsLight: true,
      kind: 'star',
    });
    expect(resolveBodyRenderingProfile('created-star-01')).toMatchObject({
      emitsLight: true,
      kind: 'star',
    });
  });

  it('按动态类型把高质量黑洞保持为非发光致密天体', () => {
    expect(resolveBodyRenderingProfile('created-black-hole-01')).toMatchObject({
      emitsLight: false,
      kind: 'black-hole',
    });
  });

  it('未知天体不会因为缺少元数据而成为光源', () => {
    expect(resolveBodyRenderingProfile('unknown-massive-body')).toMatchObject({
      emitsLight: false,
      kind: 'solid',
    });
  });
});
