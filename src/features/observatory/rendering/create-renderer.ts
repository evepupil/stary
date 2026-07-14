import type { Camera, Object3D, ToneMapping, WebGLRenderer } from 'three';

export type RendererBackend = 'webgpu' | 'webgl2';
type WebGpuRenderer = InstanceType<(typeof import('three/webgpu'))['WebGPURenderer']>;
export type ObservatoryRenderer = WebGLRenderer | WebGpuRenderer;

export interface CreatedObservatoryRenderer {
  readonly backend: RendererBackend;
  readonly renderer: ObservatoryRenderer;
}

export async function createObservatoryRenderer(): Promise<CreatedObservatoryRenderer> {
  let webGpuFailure: unknown = new Error('浏览器未提供 WebGPU');

  if ('gpu' in navigator) {
    let candidate: WebGpuRenderer | null = null;

    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter !== null) {
        const { ACESFilmicToneMapping, SRGBColorSpace, WebGPURenderer } =
          await import('three/webgpu');
        candidate = new WebGPURenderer({
          alpha: false,
          antialias: true,
          canvas: document.createElement('canvas'),
          samples: 4,
        });
        await candidate.init();
        configureRenderer(candidate, SRGBColorSpace, ACESFilmicToneMapping);

        return {
          backend: hasWebGpuBackend(candidate) ? 'webgpu' : 'webgl2',
          renderer: candidate,
        };
      }
      webGpuFailure = new Error('WebGPU 适配器不可用');
    } catch (error) {
      webGpuFailure = error;
      candidate?.dispose();
    }
  }

  try {
    const { ACESFilmicToneMapping, SRGBColorSpace, WebGLRenderer } = await import('three');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      depth: true,
      powerPreference: 'high-performance',
    });
    if (context === null) {
      throw new Error('WebGL2 上下文不可用');
    }

    const renderer = new WebGLRenderer({
      alpha: false,
      antialias: true,
      canvas,
      context,
      powerPreference: 'high-performance',
    });
    configureRenderer(renderer, SRGBColorSpace, ACESFilmicToneMapping);
    return { backend: 'webgl2', renderer };
  } catch (error) {
    throw new Error(
      `WebGPU 初始化失败（${describeError(webGpuFailure)}），WebGL2 初始化失败（${describeError(error)}）`,
      { cause: error },
    );
  }
}

export function disposeObservatoryRenderer(renderer: ObservatoryRenderer): void {
  renderer.dispose();
  if ('forceContextLoss' in renderer) {
    renderer.forceContextLoss();
  }
}

export function renderObservatoryFrame(
  renderer: ObservatoryRenderer,
  scene: Object3D,
  camera: Camera,
): void {
  renderer.render(scene, camera);
}

function configureRenderer(
  renderer: ObservatoryRenderer,
  outputColorSpace: string,
  toneMapping: ToneMapping,
): void {
  renderer.outputColorSpace = outputColorSpace;
  renderer.toneMapping = toneMapping;
  renderer.toneMappingExposure = 1;
  renderer.setClearColor(0x030506, 1);
}

function hasWebGpuBackend(renderer: WebGpuRenderer): boolean {
  return 'isWebGPUBackend' in renderer.backend && renderer.backend.isWebGPUBackend === true;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
