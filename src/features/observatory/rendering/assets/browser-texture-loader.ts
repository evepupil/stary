import {
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
} from 'three';

import type { TextureAssetDescriptor } from './texture-asset-manifest';

export interface LoadedTextureResource {
  readonly texture: Texture;
  dispose(): void;
}

export type TextureAssetLoader = (
  descriptor: TextureAssetDescriptor,
  signal: AbortSignal,
) => Promise<LoadedTextureResource>;

export const loadBrowserTextureAsset: TextureAssetLoader = async (descriptor, signal) => {
  signal.throwIfAborted();
  const response = await fetch(descriptor.url, { signal });
  if (!response.ok) {
    throw new Error(`纹理资产 ${descriptor.id} 加载失败: HTTP ${String(response.status)}`);
  }
  if (response.headers.get('content-type')?.toLowerCase().startsWith('image/') !== true) {
    throw new Error(`纹理资产 ${descriptor.id} 返回了非图片内容`);
  }

  const blob = await response.blob();
  signal.throwIfAborted();
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY' });
  if (signal.aborted) {
    bitmap.close();
    signal.throwIfAborted();
  }

  try {
    const texture = new Texture(bitmap);
    texture.name = descriptor.id;
    texture.colorSpace = descriptor.role === 'surface-color' ? SRGBColorSpace : NoColorSpace;
    texture.wrapS = descriptor.role === 'surface-color' ? RepeatWrapping : ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.userData.assetId = descriptor.id;
    texture.userData.sha256 = descriptor.sha256;
    texture.needsUpdate = true;

    let disposed = false;
    return {
      texture,
      dispose(): void {
        if (disposed) {
          return;
        }
        disposed = true;
        texture.dispose();
        bitmap.close();
      },
    };
  } catch (error) {
    bitmap.close();
    throw error;
  }
};
