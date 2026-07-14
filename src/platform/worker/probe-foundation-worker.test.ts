import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FOUNDATION_WORKER_READY_MESSAGE,
  probeFoundationWorker,
  type WorkerProbeTarget,
} from './probe-foundation-worker';

type WorkerProbeEventType = 'error' | 'message' | 'messageerror';

class FakeWorker implements WorkerProbeTarget {
  readonly listeners = new Map<WorkerProbeEventType, Set<EventListener>>();
  terminated = false;

  addEventListener(type: WorkerProbeEventType, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WorkerProbeEventType, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  terminate() {
    this.terminated = true;
  }

  emit(type: WorkerProbeEventType, event: Event) {
    this.listeners.get(type)?.forEach((listener) => {
      listener(event);
    });
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('probeFoundationWorker', () => {
  it('收到 ready 后通过并清理监听与 Worker', async () => {
    const worker = new FakeWorker();
    const promise = probeFoundationWorker({ createWorker: () => worker });

    worker.emit('message', new MessageEvent('message', { data: FOUNDATION_WORKER_READY_MESSAGE }));

    await expect(promise).resolves.toBeUndefined();
    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount()).toBe(0);
  });

  it.each([
    ['error', '模块 Worker 运行错误'],
    ['messageerror', '模块 Worker 消息无法反序列化'],
  ] as const)('%s 事件返回错误并清理', async (eventType, errorMessage) => {
    const worker = new FakeWorker();
    const promise = probeFoundationWorker({ createWorker: () => worker });

    worker.emit(eventType, new Event(eventType));

    await expect(promise).rejects.toThrow(errorMessage);
    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount()).toBe(0);
  });

  it('ready 超时后返回错误并清理', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const promise = probeFoundationWorker({ createWorker: () => worker, timeoutMs: 100 });
    const assertion = expect(promise).rejects.toThrow('100ms 内未就绪');

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount()).toBe(0);
  });

  it('取消探针后返回 AbortError 并清理', async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    const promise = probeFoundationWorker({
      createWorker: () => worker,
      signal: controller.signal,
    });

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount()).toBe(0);
  });
});
