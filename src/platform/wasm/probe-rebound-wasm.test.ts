import { describe, expect, it, vi } from 'vitest';

import type { WasmProbeDependencies } from './probe-rebound-wasm';
import { probeReboundWasm } from './probe-rebound-wasm';

const EMPTY_WASM_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function createResponse(body: BodyInit | null, contentType = 'application/wasm', status = 200) {
  return new Response(body, {
    headers: { 'content-type': contentType },
    status,
  });
}

function createDependencies(response: Response): WasmProbeDependencies {
  return {
    compileStreaming: (source) => WebAssembly.compileStreaming(source),
    fetchWasm: vi.fn(() => Promise.resolve(response)),
  };
}

describe('probeReboundWasm', () => {
  it('真实编译 application/wasm 响应后才通过', async () => {
    const dependencies = createDependencies(createResponse(EMPTY_WASM_MODULE));

    await expect(
      probeReboundWasm('/assets/rebound.wasm', { dependencies }),
    ).resolves.toBeUndefined();
  });

  it('拒绝失败的 HTTP 响应', async () => {
    const dependencies = createDependencies(createResponse(null, 'application/wasm', 404));

    await expect(probeReboundWasm('/missing.wasm', { dependencies })).rejects.toThrow('HTTP 404');
  });

  it('拒绝错误 MIME 并且不进入编译', async () => {
    const compileStreaming = vi.fn<typeof WebAssembly.compileStreaming>();
    const dependencies: WasmProbeDependencies = {
      compileStreaming,
      fetchWasm: vi.fn(() => Promise.resolve(createResponse(EMPTY_WASM_MODULE, 'text/plain'))),
    };

    await expect(probeReboundWasm('/rebound.wasm', { dependencies })).rejects.toThrow(
      'WASM MIME 错误',
    );
    expect(compileStreaming).not.toHaveBeenCalled();
  });

  it('拒绝无法编译的 WASM 内容', async () => {
    const dependencies = createDependencies(createResponse(new Uint8Array([0x00])));

    await expect(probeReboundWasm('/broken.wasm', { dependencies })).rejects.toThrow();
  });
});
