import { describe, expect, it, vi } from 'vitest';

import type { RenderingProbeDependencies } from './probe-rendering';
import { probeRenderingPath } from './probe-rendering';

function createDependencies(
  overrides: Partial<RenderingProbeDependencies> = {},
): RenderingProbeDependencies {
  return {
    hasWebGl2Context: vi.fn(() => true),
    loadWebGlModule: vi.fn(() => Promise.resolve({})),
    loadWebGpuModule: vi.fn(() => Promise.resolve({})),
    requestWebGpuAdapter: vi.fn(() => Promise.resolve({})),
    ...overrides,
  };
}

describe('probeRenderingPath', () => {
  it('适配器和模块都可用时选择 WebGPU', async () => {
    const dependencies = createDependencies();

    await expect(probeRenderingPath(dependencies)).resolves.toEqual({ backend: 'webgpu' });
    expect(dependencies.loadWebGlModule).not.toHaveBeenCalled();
  });

  it('requestAdapter 返回 null 时回退到 WebGL2', async () => {
    const dependencies = createDependencies({
      requestWebGpuAdapter: vi.fn(() => Promise.resolve(null)),
    });

    await expect(probeRenderingPath(dependencies)).resolves.toEqual({ backend: 'webgl2' });
    expect(dependencies.loadWebGlModule).toHaveBeenCalledOnce();
  });

  it('requestAdapter 抛错时回退到 WebGL2', async () => {
    const dependencies = createDependencies({
      requestWebGpuAdapter: vi.fn(() => Promise.reject(new Error('adapter failed'))),
    });

    await expect(probeRenderingPath(dependencies)).resolves.toEqual({ backend: 'webgl2' });
  });

  it('WebGPU 模块导入失败时回退到 WebGL2', async () => {
    const dependencies = createDependencies({
      loadWebGpuModule: vi.fn(() => Promise.reject(new Error('webgpu import failed'))),
    });

    await expect(probeRenderingPath(dependencies)).resolves.toEqual({ backend: 'webgl2' });
    expect(dependencies.loadWebGlModule).toHaveBeenCalledOnce();
  });

  it('两条运行时路径都不可用时返回错误', async () => {
    const dependencies = createDependencies({
      hasWebGl2Context: vi.fn(() => false),
      requestWebGpuAdapter: vi.fn(() => Promise.resolve(null)),
    });

    await expect(probeRenderingPath(dependencies)).rejects.toThrow('WebGL2 上下文不可用');
  });

  it('WebGL2 模块导入失败时返回错误', async () => {
    const dependencies = createDependencies({
      loadWebGlModule: vi.fn(() => Promise.reject(new Error('webgl import failed'))),
      requestWebGpuAdapter: vi.fn(() => Promise.resolve(null)),
    });

    await expect(probeRenderingPath(dependencies)).rejects.toThrow('WebGL2 模块导入失败');
  });
});
