export const COLLISION_KERNEL_ABI_VERSION = 1 as const;

const UINT32_MAX = 0xffff_ffff;
const INT32_MIN = -0x8000_0000;

export type CollisionKernelWasmOperation =
  | 'load'
  | 'abiVersion'
  | 'create'
  | 'alloc'
  | 'bufferPointer'
  | 'bufferLength'
  | 'writeRequest'
  | 'resolve'
  | 'readResponse'
  | 'decodeResponse'
  | 'destroy'
  | 'liveCount';

export class CollisionKernelWasmError extends Error {
  public readonly operation: CollisionKernelWasmOperation;
  public readonly status: number | undefined;

  public constructor(
    message: string,
    operation: CollisionKernelWasmOperation,
    options: { readonly cause?: unknown; readonly status?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CollisionKernelWasmError';
    this.operation = operation;
    this.status = options.status;
  }
}

type WasmI32Function = (...arguments_: number[]) => number;

export interface CollisionKernelWasmExportSource {
  readonly memory?: WebAssembly.Memory;
  readonly stary_collision_abi_version?: WasmI32Function;
  readonly stary_collision_create?: WasmI32Function;
  readonly stary_collision_alloc?: WasmI32Function;
  readonly stary_collision_buffer_ptr?: WasmI32Function;
  readonly stary_collision_buffer_len?: WasmI32Function;
  readonly stary_collision_resolve?: WasmI32Function;
  readonly stary_collision_destroy?: WasmI32Function;
  readonly stary_collision_live_count?: WasmI32Function;
}

interface CollisionKernelWasmExports {
  readonly memory: WebAssembly.Memory;
  readonly abiVersion: () => number;
  readonly create: () => number;
  readonly alloc: (token: number, byteLength: number) => number;
  readonly bufferPointer: (token: number) => number;
  readonly bufferLength: (token: number) => number;
  readonly resolve: (token: number) => number;
  readonly destroy: (token: number) => number;
  readonly liveCount: () => number;
}

export interface CollisionKernelWasm {
  readonly abiVersion: typeof COLLISION_KERNEL_ABI_VERSION;
  resolveJson(request: unknown): unknown;
  liveContextCount(): number;
}

export interface CollisionKernelWasmLoadDependencies {
  readonly fetchWasm: (url: string, signal: AbortSignal | undefined) => Promise<Response>;
  readonly instantiate: (bytes: ArrayBuffer) => Promise<WebAssembly.Instance>;
}

export interface CollisionKernelWasmLoadOptions {
  readonly dependencies?: CollisionKernelWasmLoadDependencies;
  readonly signal?: AbortSignal;
  readonly url?: string;
}

const browserLoadDependencies: CollisionKernelWasmLoadDependencies = {
  fetchWasm: (url, signal) => fetch(url, signal === undefined ? undefined : { signal }),
  instantiate: async (bytes) => {
    const result = await WebAssembly.instantiate(bytes, {});
    return result.instance;
  },
};

function requiredFunction(
  exports: CollisionKernelWasmExportSource,
  name: keyof CollisionKernelWasmExportSource,
): WasmI32Function {
  const value = exports[name];
  if (typeof value !== 'function') {
    throw new CollisionKernelWasmError(`Collision WASM 缺少导出 ${name}`, 'load');
  }
  return value;
}

function parseExports(source: CollisionKernelWasmExportSource): CollisionKernelWasmExports {
  if (!(source.memory instanceof WebAssembly.Memory)) {
    throw new CollisionKernelWasmError('Collision WASM 缺少导出 memory', 'load');
  }
  return {
    memory: source.memory,
    abiVersion: requiredFunction(source, 'stary_collision_abi_version'),
    create: requiredFunction(source, 'stary_collision_create'),
    alloc: requiredFunction(source, 'stary_collision_alloc'),
    bufferPointer: requiredFunction(source, 'stary_collision_buffer_ptr'),
    bufferLength: requiredFunction(source, 'stary_collision_buffer_len'),
    resolve: requiredFunction(source, 'stary_collision_resolve'),
    destroy: requiredFunction(source, 'stary_collision_destroy'),
    liveCount: requiredFunction(source, 'stary_collision_live_count'),
  };
}

function callWasm(operation: CollisionKernelWasmOperation, call: () => number): number {
  try {
    return call();
  } catch (cause) {
    throw new CollisionKernelWasmError(`Collision WASM ${operation} 调用失败`, operation, {
      cause,
    });
  }
}

function unsignedI32(value: number, operation: CollisionKernelWasmOperation): number {
  if (!Number.isInteger(value) || value < INT32_MIN || value > UINT32_MAX) {
    throw new CollisionKernelWasmError(
      `Collision WASM ${operation} 返回了无效的 32 位整数 ${String(value)}`,
      operation,
    );
  }
  return value >>> 0;
}

function expectSuccessStatus(operation: CollisionKernelWasmOperation, status: number): void {
  if (!Number.isInteger(status) || status !== 0) {
    throw new CollisionKernelWasmError(
      `Collision WASM ${operation} 返回状态 ${String(status)}`,
      operation,
      { status },
    );
  }
}

function encodeRequest(request: unknown): Uint8Array {
  if (request === undefined || typeof request === 'function' || typeof request === 'symbol') {
    throw new CollisionKernelWasmError('Collision WASM 请求无法编码为 JSON', 'writeRequest');
  }
  let json: string;
  try {
    json = JSON.stringify(request);
  } catch (cause) {
    throw new CollisionKernelWasmError('Collision WASM 请求无法编码为 JSON', 'writeRequest', {
      cause,
    });
  }
  return new TextEncoder().encode(json);
}

function bufferView(
  exports: CollisionKernelWasmExports,
  token: number,
  expectedByteLength: number | null,
  operation: 'writeRequest' | 'readResponse',
): Uint8Array {
  const pointer = unsignedI32(
    callWasm('bufferPointer', () => exports.bufferPointer(token)),
    'bufferPointer',
  );
  const byteLength = unsignedI32(
    callWasm('bufferLength', () => exports.bufferLength(token)),
    'bufferLength',
  );
  if (pointer === 0 || byteLength === 0) {
    throw new CollisionKernelWasmError(`Collision WASM ${operation} 返回了空缓冲区`, operation);
  }
  if (expectedByteLength !== null && byteLength !== expectedByteLength) {
    throw new CollisionKernelWasmError(
      `Collision WASM 请求缓冲区长度不一致：预期 ${String(expectedByteLength)}，实际 ${String(byteLength)}`,
      operation,
    );
  }

  // Any preceding export may grow memory and detach an older ArrayBuffer.
  const memoryBuffer = exports.memory.buffer;
  const end = pointer + byteLength;
  if (end > memoryBuffer.byteLength) {
    throw new CollisionKernelWasmError(`Collision WASM ${operation} 缓冲区越界`, operation);
  }
  try {
    return new Uint8Array(memoryBuffer, pointer, byteLength);
  } catch (cause) {
    throw new CollisionKernelWasmError(`Collision WASM ${operation} 无法访问缓冲区`, operation, {
      cause,
    });
  }
}

class CollisionKernelWasmAdapter implements CollisionKernelWasm {
  public readonly abiVersion = COLLISION_KERNEL_ABI_VERSION;

  public constructor(private readonly exports: CollisionKernelWasmExports) {
    const actualVersion = unsignedI32(
      callWasm('abiVersion', () => exports.abiVersion()),
      'abiVersion',
    );
    if (actualVersion !== COLLISION_KERNEL_ABI_VERSION) {
      throw new CollisionKernelWasmError(
        `Collision WASM ABI 版本不兼容：预期 ${String(COLLISION_KERNEL_ABI_VERSION)}，实际 ${String(actualVersion)}`,
        'abiVersion',
      );
    }
  }

  public resolveJson(request: unknown): unknown {
    const requestBytes = encodeRequest(request);
    const token = unsignedI32(
      callWasm('create', () => this.exports.create()),
      'create',
    );
    if (token === 0) {
      throw new CollisionKernelWasmError('Collision WASM 无法创建上下文', 'create');
    }

    try {
      expectSuccessStatus(
        'alloc',
        callWasm('alloc', () => this.exports.alloc(token, requestBytes.byteLength)),
      );
      const requestView = bufferView(this.exports, token, requestBytes.byteLength, 'writeRequest');
      try {
        requestView.set(requestBytes);
      } catch (cause) {
        throw new CollisionKernelWasmError('Collision WASM 请求写入失败', 'writeRequest', {
          cause,
        });
      }

      expectSuccessStatus(
        'resolve',
        callWasm('resolve', () => this.exports.resolve(token)),
      );
      const responseView = bufferView(this.exports, token, null, 'readResponse');

      let responseJson: string;
      try {
        responseJson = new TextDecoder('utf-8', { fatal: true }).decode(responseView);
      } catch (cause) {
        throw new CollisionKernelWasmError('Collision WASM 响应不是合法 UTF-8', 'decodeResponse', {
          cause,
        });
      }
      try {
        return JSON.parse(responseJson) as unknown;
      } catch (cause) {
        throw new CollisionKernelWasmError('Collision WASM 响应不是合法 JSON', 'decodeResponse', {
          cause,
        });
      }
    } finally {
      expectSuccessStatus(
        'destroy',
        callWasm('destroy', () => this.exports.destroy(token)),
      );
    }
  }

  public liveContextCount(): number {
    return unsignedI32(
      callWasm('liveCount', () => this.exports.liveCount()),
      'liveCount',
    );
  }
}

export function createCollisionKernelWasm(
  source: CollisionKernelWasmExportSource,
): CollisionKernelWasm {
  return new CollisionKernelWasmAdapter(parseExports(source));
}

export async function loadCollisionKernelWasm(
  options: CollisionKernelWasmLoadOptions = {},
): Promise<CollisionKernelWasm> {
  const dependencies = options.dependencies ?? browserLoadDependencies;
  const url =
    options.url ?? (await import('../../platform/wasm/collision-asset')).COLLISION_WASM_URL;
  let response: Response;
  try {
    response = await dependencies.fetchWasm(url, options.signal);
  } catch (cause) {
    throw new CollisionKernelWasmError('Collision WASM 请求失败', 'load', { cause });
  }
  if (!response.ok) {
    throw new CollisionKernelWasmError(
      `Collision WASM 请求失败：HTTP ${String(response.status)}`,
      'load',
    );
  }

  let instance: WebAssembly.Instance;
  try {
    instance = await dependencies.instantiate(await response.arrayBuffer());
  } catch (cause) {
    throw new CollisionKernelWasmError('Collision WASM 实例化失败', 'load', { cause });
  }
  return createCollisionKernelWasm(instance.exports);
}
