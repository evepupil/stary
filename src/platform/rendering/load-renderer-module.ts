export async function loadWebGpuRendererModule(): Promise<typeof import('three/webgpu')> {
  return import('three/webgpu');
}

export async function loadWebGlRendererModule(): Promise<typeof import('three')> {
  return import('three');
}
