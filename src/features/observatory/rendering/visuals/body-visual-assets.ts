import type { MeshBasicMaterial, MeshStandardMaterial } from 'three';

import type { BodyAssetPlan } from '../assets/body-asset-plan';
import { TextureAssetCache, type TextureLease } from '../assets/texture-cache';
import type { PlanetaryRingVisual } from './planetary-ring';

export type VisualAssetState = 'procedural' | 'idle' | 'loading' | 'ready' | 'fallback';

export interface BodyVisualAssetDiagnostics {
  readonly ring: {
    readonly assetId: string | null;
    readonly bound: boolean;
    readonly state: VisualAssetState;
  };
  readonly surface: {
    readonly assetId: string | null;
    readonly bound: boolean;
    readonly state: VisualAssetState;
  };
}

type SurfaceMaterial = MeshBasicMaterial | MeshStandardMaterial;

export class BodyVisualAssetBinding {
  private readonly controller = new AbortController();
  private disposed = false;
  private ringLease: TextureLease | null = null;
  private ringState: VisualAssetState;
  private settlePromise: Promise<void> = Promise.resolve();
  private started = false;
  private surfaceLease: TextureLease | null = null;
  private surfaceState: VisualAssetState;

  constructor(
    private readonly material: SurfaceMaterial,
    private readonly planetaryRing: PlanetaryRingVisual | null,
    private readonly plan: BodyAssetPlan,
    private readonly cache: TextureAssetCache,
  ) {
    this.surfaceState = plan.surface === null ? 'procedural' : 'idle';
    this.ringState = plan.ring === null ? 'procedural' : 'idle';
  }

  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    if (this.plan.surface !== null) {
      this.surfaceState = 'loading';
    }
    if (this.plan.ring !== null) {
      this.ringState = 'loading';
    }
    this.settlePromise = Promise.all([this.loadSurface(), this.loadRing()]).then(() => undefined);
  }

  whenSettled(): Promise<void> {
    return this.settlePromise;
  }

  hasSurfaceTexture(): boolean {
    return this.surfaceLease !== null && this.material.map === this.surfaceLease.texture;
  }

  diagnostics(): BodyVisualAssetDiagnostics {
    return {
      ring: {
        assetId: this.plan.ring?.opacityAsset.id ?? null,
        bound:
          this.ringLease !== null &&
          this.planetaryRing?.mesh.material.alphaMap === this.ringLease.texture,
        state: this.ringState,
      },
      surface: {
        assetId: this.plan.surface?.id ?? null,
        bound: this.hasSurfaceTexture(),
        state: this.surfaceState,
      },
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.controller.abort();
    if (this.surfaceLease !== null) {
      if (this.material.map === this.surfaceLease.texture) {
        this.material.map = null;
        this.material.needsUpdate = true;
      }
      this.surfaceLease.release();
      this.surfaceLease = null;
    }
    if (this.ringLease !== null) {
      if (this.planetaryRing?.mesh.material.alphaMap === this.ringLease.texture) {
        this.planetaryRing.mesh.material.alphaMap = this.planetaryRing.fallbackAlphaMap;
        this.planetaryRing.mesh.material.needsUpdate = true;
      }
      this.ringLease.release();
      this.ringLease = null;
    }
  }

  private async loadSurface(): Promise<void> {
    const descriptor = this.plan.surface;
    if (descriptor === null) {
      return;
    }
    try {
      const lease = await this.cache.acquire(descriptor, this.controller.signal);
      if (this.disposed) {
        lease.release();
        return;
      }
      this.surfaceLease = lease;
      this.material.map = lease.texture;
      this.material.color.setHex(0xffffff);
      this.material.needsUpdate = true;
      this.surfaceState = 'ready';
    } catch (error) {
      if (!this.disposed && !isAbortError(error)) {
        this.surfaceState = 'fallback';
      }
    }
  }

  private async loadRing(): Promise<void> {
    const descriptor = this.plan.ring?.opacityAsset;
    if (descriptor === undefined || this.planetaryRing === null) {
      return;
    }
    try {
      const lease = await this.cache.acquire(descriptor, this.controller.signal);
      if (this.disposed) {
        lease.release();
        return;
      }
      this.ringLease = lease;
      this.planetaryRing.mesh.material.alphaMap = lease.texture;
      this.planetaryRing.mesh.material.needsUpdate = true;
      this.ringState = 'ready';
    } catch (error) {
      if (!this.disposed && !isAbortError(error)) {
        this.ringState = 'fallback';
      }
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
