import { Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { LoadedTextureResource, TextureAssetLoader } from './browser-texture-loader';
import { TextureAssetCache } from './texture-cache';
import { getTextureAssetDescriptor } from './texture-asset-manifest';

interface Deferred<T> {
  readonly promise: Promise<T>;
  reject(reason: unknown): void;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    reject(reason): void {
      rejectPromise?.(reason);
    },
    resolve(value): void {
      resolvePromise?.(value);
    },
  };
}

interface TestTextureResource extends LoadedTextureResource {
  readonly dispose: ReturnType<typeof vi.fn<() => void>>;
}

function textureResource(): TestTextureResource {
  return { dispose: vi.fn<() => void>(), texture: new Texture() };
}

describe('TextureAssetCache', () => {
  const descriptor = getTextureAssetDescriptor('earth-surface');

  it('共享同一加载，并在最后一个租约释放时只销毁一次', async () => {
    const resource = textureResource();
    const loader = vi.fn<TextureAssetLoader>().mockResolvedValue(resource);
    const cache = new TextureAssetCache(loader);

    const [first, second] = await Promise.all([
      cache.acquire(descriptor),
      cache.acquire(descriptor),
    ]);

    expect(loader).toHaveBeenCalledOnce();
    expect(first.texture).toBe(second.texture);
    expect(cache.snapshot()).toMatchObject({ ready: 1, references: 2 });
    first.release();
    first.release();
    expect(resource.dispose).not.toHaveBeenCalled();
    second.release();
    expect(resource.dispose).toHaveBeenCalledOnce();
    expect(cache.snapshot()).toMatchObject({ ready: 0, references: 0 });
  });

  it('单个等待方取消不会中断其他等待方', async () => {
    const pending = deferred<LoadedTextureResource>();
    const loaderSignals: AbortSignal[] = [];
    const loader: TextureAssetLoader = (_asset, signal) => {
      loaderSignals.push(signal);
      return pending.promise;
    };
    const cache = new TextureAssetCache(loader);
    const cancelled = new AbortController();
    const cancelledAcquire = cache.acquire(descriptor, cancelled.signal);
    const remainingAcquire = cache.acquire(descriptor);

    cancelled.abort();
    await expect(cancelledAcquire).rejects.toMatchObject({ name: 'AbortError' });
    expect(loaderSignals[0]?.aborted).toBe(false);

    const resource = textureResource();
    pending.resolve(resource);
    const remaining = await remainingAcquire;
    expect(remaining.texture).toBe(resource.texture);
    remaining.release();
    expect(resource.dispose).toHaveBeenCalledOnce();
  });

  it('全部等待方取消会中断底层加载并释放迟到资源', async () => {
    const pending = deferred<LoadedTextureResource>();
    const loaderSignals: AbortSignal[] = [];
    const loader: TextureAssetLoader = (_asset, signal) => {
      loaderSignals.push(signal);
      return pending.promise;
    };
    const cache = new TextureAssetCache(loader);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = cache.acquire(descriptor, firstController.signal);
    const second = cache.acquire(descriptor, secondController.signal);

    firstController.abort();
    secondController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(loaderSignals[0]?.aborted).toBe(true);

    const lateResource = textureResource();
    pending.resolve(lateResource);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateResource.dispose).toHaveBeenCalledOnce();
  });

  it('失败条目会移出缓存并允许重试', async () => {
    const resource = textureResource();
    const loader = vi
      .fn<TextureAssetLoader>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(resource);
    const cache = new TextureAssetCache(loader);

    await expect(cache.acquire(descriptor)).rejects.toThrow('network');
    const lease = await cache.acquire(descriptor);
    expect(loader).toHaveBeenCalledTimes(2);
    lease.release();
    expect(resource.dispose).toHaveBeenCalledOnce();
  });

  it('整体销毁会释放就绪资源并拒绝新请求', async () => {
    const resource = textureResource();
    const cache = new TextureAssetCache(vi.fn<TextureAssetLoader>().mockResolvedValue(resource));
    const lease = await cache.acquire(descriptor);

    cache.dispose();
    cache.dispose();
    lease.release();
    expect(resource.dispose).toHaveBeenCalledOnce();
    await expect(cache.acquire(descriptor)).rejects.toThrow('纹理缓存已经销毁');
  });

  it('等待期间整体销毁会中断加载并释放迟到资源', async () => {
    const pending = deferred<LoadedTextureResource>();
    let loaderSignal: AbortSignal | undefined;
    const loader: TextureAssetLoader = (_asset, signal) => {
      loaderSignal = signal;
      return pending.promise;
    };
    const cache = new TextureAssetCache(loader);
    const acquire = cache.acquire(descriptor);
    await Promise.resolve();

    cache.dispose();
    expect(loaderSignal?.aborted).toBe(true);

    const lateResource = textureResource();
    pending.resolve(lateResource);
    await expect(acquire).rejects.toMatchObject({ name: 'AbortError' });
    expect(lateResource.dispose).toHaveBeenCalledOnce();
    expect(cache.snapshot()).toEqual({
      disposed: true,
      loading: 0,
      ready: 0,
      references: 0,
      waiters: 0,
    });
  });
});
