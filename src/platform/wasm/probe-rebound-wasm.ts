export interface WasmProbeDependencies {
  readonly compileStreaming: (
    source: Response | PromiseLike<Response>,
  ) => Promise<WebAssembly.Module>;
  readonly fetchWasm: (url: string, signal: AbortSignal | undefined) => Promise<Response>;
}

export interface WasmProbeOptions {
  readonly dependencies?: WasmProbeDependencies;
  readonly signal?: AbortSignal;
}

const browserWasmProbeDependencies: WasmProbeDependencies = {
  compileStreaming: (source) => WebAssembly.compileStreaming(source),
  fetchWasm: (url, signal) => fetch(url, signal === undefined ? undefined : { signal }),
};

export async function probeReboundWasm(url: string, options: WasmProbeOptions = {}): Promise<void> {
  const dependencies = options.dependencies ?? browserWasmProbeDependencies;
  const response = await dependencies.fetchWasm(url, options.signal);

  if (!response.ok) {
    throw new Error(`WASM 请求失败：HTTP ${String(response.status)}`);
  }

  const contentType = response.headers.get('content-type');
  const mimeType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (mimeType !== 'application/wasm') {
    throw new Error(`WASM MIME 错误：${contentType ?? '缺失 Content-Type'}`);
  }

  await dependencies.compileStreaming(response);
}
