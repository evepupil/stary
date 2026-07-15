import { describe, expect, it, vi } from 'vitest';

import { loadBrowserTextureAsset } from './browser-texture-loader';
import { getTextureAssetDescriptor } from './texture-asset-manifest';

describe('browser texture loader', () => {
  const descriptor = getTextureAssetDescriptor('earth-surface');

  it('验证图片响应、配置颜色纹理并幂等释放位图', async () => {
    const close = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Blob(['image']), {
          headers: { 'content-type': 'image/webp' },
          status: 200,
        }),
      ),
    );
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close }));

    const resource = await loadBrowserTextureAsset(descriptor, new AbortController().signal);
    expect(resource.texture.name).toBe('earth-surface');
    expect(resource.texture.userData.sha256).toBe(descriptor.sha256);
    resource.dispose();
    resource.dispose();
    expect(close).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('拒绝非图片响应，并关闭取消后迟到的位图', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<html></html>', {
          headers: { 'content-type': 'text/html' },
          status: 200,
        }),
      ),
    );
    await expect(loadBrowserTextureAsset(descriptor, new AbortController().signal)).rejects.toThrow(
      '非图片内容',
    );

    const controller = new AbortController();
    const close = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Blob(['image']), {
          headers: { 'content-type': 'image/webp' },
          status: 200,
        }),
      ),
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockImplementation(() => {
        controller.abort();
        return Promise.resolve({ close });
      }),
    );
    await expect(loadBrowserTextureAsset(descriptor, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(close).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
