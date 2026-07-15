import type { Texture } from 'three';

import {
  loadBrowserTextureAsset,
  type LoadedTextureResource,
  type TextureAssetLoader,
} from './browser-texture-loader';
import type { TextureAssetDescriptor } from './texture-asset-manifest';

interface TextureCacheEntry {
  readonly controller: AbortController;
  readonly descriptor: TextureAssetDescriptor;
  readonly promise: Promise<LoadedTextureResource>;
  readonly waiters: Set<symbol>;
  references: number;
  resource: LoadedTextureResource | null;
  resourceDisposed: boolean;
}

export interface TextureLease {
  readonly assetId: string;
  readonly texture: Texture;
  release(): void;
}

export interface TextureCacheSnapshot {
  readonly disposed: boolean;
  readonly loading: number;
  readonly ready: number;
  readonly references: number;
  readonly waiters: number;
}

export class TextureAssetCache {
  private readonly entries = new Map<string, TextureCacheEntry>();
  private disposed = false;

  constructor(private readonly loader: TextureAssetLoader = loadBrowserTextureAsset) {}

  acquire(descriptor: TextureAssetDescriptor, signal?: AbortSignal): Promise<TextureLease> {
    if (this.disposed) {
      return Promise.reject(new Error('纹理缓存已经销毁'));
    }
    if (signal?.aborted === true) {
      return Promise.reject(createAbortError());
    }

    const entry = this.entries.get(descriptor.id) ?? this.createEntry(descriptor);
    const waiter = Symbol(descriptor.id);
    entry.waiters.add(waiter);

    return new Promise<TextureLease>((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        entry.waiters.delete(waiter);
        signal?.removeEventListener('abort', handleAbort);
      };
      const handleAbort = (): void => {
        if (settled) {
          return;
        }
        finish();
        this.cleanupUnusedEntry(entry);
        reject(createAbortError());
      };
      signal?.addEventListener('abort', handleAbort, { once: true });

      void entry.promise.then(
        (resource) => {
          if (settled) {
            return;
          }
          finish();
          if (
            this.disposed ||
            signal?.aborted === true ||
            this.entries.get(descriptor.id) !== entry ||
            entry.resource !== resource ||
            entry.resourceDisposed
          ) {
            this.cleanupUnusedEntry(entry);
            reject(createAbortError());
            return;
          }

          entry.references += 1;
          resolve(this.createLease(entry));
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          finish();
          reject(toError(error));
        },
      );
    });
  }

  snapshot(): TextureCacheSnapshot {
    let loading = 0;
    let ready = 0;
    let references = 0;
    let waiters = 0;
    for (const entry of this.entries.values()) {
      if (entry.resource === null) {
        loading += 1;
      } else {
        ready += 1;
      }
      references += entry.references;
      waiters += entry.waiters.size;
    }
    return { disposed: this.disposed, loading, ready, references, waiters };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.controller.abort();
      this.disposeEntryResource(entry);
    }
    this.entries.clear();
  }

  private createEntry(descriptor: TextureAssetDescriptor): TextureCacheEntry {
    const controller = new AbortController();
    const entry = {} as TextureCacheEntry;
    Object.assign(entry, {
      controller,
      descriptor,
      references: 0,
      resource: null,
      resourceDisposed: false,
      waiters: new Set<symbol>(),
      promise: Promise.resolve()
        .then(() => this.loader(descriptor, controller.signal))
        .then((resource) => {
          if (
            this.disposed ||
            controller.signal.aborted ||
            this.entries.get(descriptor.id) !== entry
          ) {
            resource.dispose();
            entry.resourceDisposed = true;
            throw createAbortError();
          }
          entry.resource = resource;
          return resource;
        })
        .catch((error: unknown) => {
          if (this.entries.get(descriptor.id) === entry) {
            this.entries.delete(descriptor.id);
          }
          throw error;
        }),
    });
    this.entries.set(descriptor.id, entry);
    return entry;
  }

  private createLease(entry: TextureCacheEntry): TextureLease {
    const resource = entry.resource;
    if (resource === null) {
      throw new Error(`纹理缓存 ${entry.descriptor.id} 尚未就绪`);
    }
    let released = false;
    return {
      assetId: entry.descriptor.id,
      texture: resource.texture,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        entry.references = Math.max(0, entry.references - 1);
        this.cleanupUnusedEntry(entry);
      },
    };
  }

  private cleanupUnusedEntry(entry: TextureCacheEntry): void {
    if (entry.references > 0 || entry.waiters.size > 0) {
      return;
    }
    if (this.entries.get(entry.descriptor.id) === entry) {
      this.entries.delete(entry.descriptor.id);
    }
    if (entry.resource === null) {
      entry.controller.abort();
      return;
    }
    this.disposeEntryResource(entry);
  }

  private disposeEntryResource(entry: TextureCacheEntry): void {
    if (entry.resource === null || entry.resourceDisposed) {
      return;
    }
    entry.resourceDisposed = true;
    entry.resource.dispose();
  }
}

function createAbortError(): DOMException {
  return new DOMException('纹理加载已取消', 'AbortError');
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
