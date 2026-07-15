import { describe, expect, it, vi } from 'vitest';

import { disposeObservatoryRenderer, type ObservatoryRenderer } from './create-renderer';
import { recordRendererCreated, snapshotRenderLifecycle } from './render-lifecycle-diagnostics';

describe('disposeObservatoryRenderer', () => {
  it('只释放一次 WebGL2 renderer 和图形上下文', () => {
    const dispose = vi.fn();
    const forceContextLoss = vi.fn();
    const renderer = { dispose, forceContextLoss } as unknown as ObservatoryRenderer;
    const before = snapshotRenderLifecycle();
    recordRendererCreated();

    disposeObservatoryRenderer(renderer);
    disposeObservatoryRenderer(renderer);

    expect(dispose).toHaveBeenCalledOnce();
    expect(forceContextLoss).toHaveBeenCalledOnce();
    expect(snapshotRenderLifecycle()).toEqual({
      activeRenderers: before.activeRenderers,
      activeScenes: before.activeScenes,
      renderersCreated: before.renderersCreated + 1,
      renderersDisposed: before.renderersDisposed + 1,
      scenesCreated: before.scenesCreated,
      scenesDisposed: before.scenesDisposed,
    });
  });

  it('只释放一次 WebGPU renderer', () => {
    const dispose = vi.fn();
    const renderer = { dispose } as unknown as ObservatoryRenderer;
    const before = snapshotRenderLifecycle();
    recordRendererCreated();

    disposeObservatoryRenderer(renderer);
    disposeObservatoryRenderer(renderer);

    expect(dispose).toHaveBeenCalledOnce();
    expect(snapshotRenderLifecycle()).toEqual({
      activeRenderers: before.activeRenderers,
      activeScenes: before.activeScenes,
      renderersCreated: before.renderersCreated + 1,
      renderersDisposed: before.renderersDisposed + 1,
      scenesCreated: before.scenesCreated,
      scenesDisposed: before.scenesDisposed,
    });
  });
});
