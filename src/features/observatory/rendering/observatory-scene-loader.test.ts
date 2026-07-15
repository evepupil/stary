import { describe, expect, it } from 'vitest';

import {
  addObservatorySceneRetry,
  extractObservatorySceneChunkUrl,
} from './observatory-scene-loader';

describe('observatory scene loader', () => {
  it('从同源动态导入错误中提取场景分块 URL', () => {
    const error = new TypeError(
      'Failed to fetch dynamically imported module: http://127.0.0.1:4173/assets/observatory-scene-Ab12Cd.js',
    );

    expect(extractObservatorySceneChunkUrl(error, 'http://127.0.0.1:4173/')).toEqual(
      new URL('http://127.0.0.1:4173/assets/observatory-scene-Ab12Cd.js'),
    );
  });

  it('拒绝跨域地址和其他动态分块', () => {
    expect(
      extractObservatorySceneChunkUrl(
        new Error(
          'Failed http://example.com/assets/observatory-scene-Ab12Cd.js and http://127.0.0.1:4173/assets/webgpu-Ab12Cd.js',
        ),
        'http://127.0.0.1:4173/',
      ),
    ).toBeNull();
  });

  it('为每次重试替换同一个缓存绕过参数', () => {
    const failedUrl = new URL(
      'http://127.0.0.1:4173/assets/observatory-scene-Ab12Cd.js?starySceneRetry=1',
    );

    expect(addObservatorySceneRetry(failedUrl, 2)).toBe(
      'http://127.0.0.1:4173/assets/observatory-scene-Ab12Cd.js?starySceneRetry=2',
    );
  });
});
