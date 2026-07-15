export interface RenderLifecycleSnapshot {
  readonly activeRenderers: number;
  readonly activeScenes: number;
  readonly renderersCreated: number;
  readonly renderersDisposed: number;
  readonly scenesCreated: number;
  readonly scenesDisposed: number;
}

let renderersCreated = 0;
let renderersDisposed = 0;
let scenesCreated = 0;
let scenesDisposed = 0;

export function recordRendererCreated(): void {
  renderersCreated += 1;
}

export function recordRendererDisposed(): void {
  if (renderersDisposed >= renderersCreated) {
    throw new Error('renderer 释放数量不能超过创建数量');
  }
  renderersDisposed += 1;
}

export function recordSceneCreated(): void {
  scenesCreated += 1;
}

export function recordSceneDisposed(): void {
  if (scenesDisposed >= scenesCreated) {
    throw new Error('scene 释放数量不能超过创建数量');
  }
  scenesDisposed += 1;
}

export function snapshotRenderLifecycle(): RenderLifecycleSnapshot {
  return {
    activeRenderers: renderersCreated - renderersDisposed,
    activeScenes: scenesCreated - scenesDisposed,
    renderersCreated,
    renderersDisposed,
    scenesCreated,
    scenesDisposed,
  };
}
