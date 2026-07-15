import { describe, expect, it } from 'vitest';

import {
  recordRendererCreated,
  recordRendererDisposed,
  recordSceneCreated,
  recordSceneDisposed,
  snapshotRenderLifecycle,
} from './render-lifecycle-diagnostics';

describe('render lifecycle diagnostics', () => {
  it('记录累计数量并保持活动实例守恒', () => {
    const before = snapshotRenderLifecycle();

    recordRendererCreated();
    recordSceneCreated();
    expect(snapshotRenderLifecycle()).toEqual({
      activeRenderers: before.activeRenderers + 1,
      activeScenes: before.activeScenes + 1,
      renderersCreated: before.renderersCreated + 1,
      renderersDisposed: before.renderersDisposed,
      scenesCreated: before.scenesCreated + 1,
      scenesDisposed: before.scenesDisposed,
    });

    recordSceneDisposed();
    recordRendererDisposed();
    expect(snapshotRenderLifecycle()).toEqual({
      activeRenderers: before.activeRenderers,
      activeScenes: before.activeScenes,
      renderersCreated: before.renderersCreated + 1,
      renderersDisposed: before.renderersDisposed + 1,
      scenesCreated: before.scenesCreated + 1,
      scenesDisposed: before.scenesDisposed + 1,
    });
  });
});
