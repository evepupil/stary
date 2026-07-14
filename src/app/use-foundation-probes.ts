import { useEffect, useState } from 'react';

import {
  createProbeState,
  describeUnknownError,
  type ProbeState,
} from '../platform/probes/probe-state';
import { probeRenderingPath } from '../platform/rendering/probe-rendering';
import { REBOUND_WASM_URL } from '../platform/wasm/rebound-asset';
import { probeReboundWasm } from '../platform/wasm/probe-rebound-wasm';
import { probeFoundationWorker } from '../platform/worker/probe-foundation-worker';

export interface FoundationProbeStates {
  readonly renderer: ProbeState;
  readonly wasm: ProbeState;
  readonly worker: ProbeState;
}

function createLoadingStates(): FoundationProbeStates {
  return {
    renderer: createProbeState('loading', '检查适配器、上下文与模块导入'),
    wasm: createProbeState('loading', '检查请求、MIME 与流式编译'),
    worker: createProbeState('loading', '等待模块 Worker ready'),
  };
}

export function useFoundationProbes(): FoundationProbeStates {
  const [states, setStates] = useState(createLoadingStates);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const update = (name: keyof FoundationProbeStates, state: ProbeState) => {
      if (active) {
        setStates((current) => ({ ...current, [name]: state }));
      }
    };
    const fail = (name: keyof FoundationProbeStates, error: unknown) => {
      update(name, createProbeState('error', describeUnknownError(error)));
    };

    void probeRenderingPath()
      .then(({ backend }) => {
        const message =
          backend === 'webgpu'
            ? 'WebGPU 适配器与模块导入通过'
            : 'WebGPU 不可用，WebGL2 上下文与模块导入通过';
        update('renderer', createProbeState('ready', message));
      })
      .catch((error: unknown) => {
        fail('renderer', error);
      });

    void probeReboundWasm(REBOUND_WASM_URL, { signal: controller.signal })
      .then(() => {
        update('wasm', createProbeState('ready', '请求、MIME 与流式编译通过'));
      })
      .catch((error: unknown) => {
        fail('wasm', error);
      });

    void probeFoundationWorker({ signal: controller.signal })
      .then(() => {
        update('worker', createProbeState('ready', '模块 Worker ready 探针通过'));
      })
      .catch((error: unknown) => {
        fail('worker', error);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  return states;
}
