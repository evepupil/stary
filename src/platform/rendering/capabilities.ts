export type RendererBackend = 'webgpu' | 'webgl2';

export async function requestBrowserWebGpuAdapter(): Promise<GPUAdapter | null> {
  if (!('gpu' in navigator)) {
    return null;
  }

  return navigator.gpu.requestAdapter();
}

export function hasBrowserWebGl2Context(): boolean {
  const canvas = document.createElement('canvas');
  return canvas.getContext('webgl2') !== null;
}
