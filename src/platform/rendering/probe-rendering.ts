import { describeUnknownError } from '../probes/probe-state';
import type { RendererBackend } from './capabilities';
import { hasBrowserWebGl2Context, requestBrowserWebGpuAdapter } from './capabilities';
import { loadWebGlRendererModule, loadWebGpuRendererModule } from './load-renderer-module';

export interface RenderingProbeResult {
  readonly backend: RendererBackend;
}

export interface RenderingProbeDependencies {
  readonly hasWebGl2Context: () => boolean;
  readonly loadWebGlModule: () => Promise<unknown>;
  readonly loadWebGpuModule: () => Promise<unknown>;
  readonly requestWebGpuAdapter: () => Promise<object | null>;
}

const browserRenderingProbeDependencies: RenderingProbeDependencies = {
  hasWebGl2Context: hasBrowserWebGl2Context,
  loadWebGlModule: loadWebGlRendererModule,
  loadWebGpuModule: loadWebGpuRendererModule,
  requestWebGpuAdapter: requestBrowserWebGpuAdapter,
};

export async function probeRenderingPath(
  dependencies: RenderingProbeDependencies = browserRenderingProbeDependencies,
): Promise<RenderingProbeResult> {
  let webGpuFailure = '适配器不可用';

  try {
    const adapter = await dependencies.requestWebGpuAdapter();
    if (adapter !== null) {
      await dependencies.loadWebGpuModule();
      return { backend: 'webgpu' };
    }
  } catch (error) {
    webGpuFailure = describeUnknownError(error);
  }

  if (!dependencies.hasWebGl2Context()) {
    throw new Error(`WebGPU 路径失败（${webGpuFailure}），WebGL2 上下文不可用`);
  }

  try {
    await dependencies.loadWebGlModule();
    return { backend: 'webgl2' };
  } catch (error) {
    throw new Error(
      `WebGPU 路径失败（${webGpuFailure}），WebGL2 模块导入失败：${describeUnknownError(error)}`,
      { cause: error },
    );
  }
}
