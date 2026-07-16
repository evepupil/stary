import { describe, expect, it } from 'vitest';

import type { BodyState } from '../protocol/schemas';
import {
  requestTrajectoryPreview,
  type OrbitPreviewWorkerTarget,
} from './request-trajectory-preview';
import {
  ORBIT_PREVIEW_PROTOCOL_VERSION,
  type TrajectoryPreviewRequest,
  type TrajectoryPreviewResponse,
  type TrajectoryPreviewResult,
} from './schemas';
import { createPreviewTestBody } from './test-helpers';

type WorkerEventType = 'error' | 'message' | 'messageerror';

const bodies: readonly BodyState[] = [
  createPreviewTestBody({
    id: 'reference',
    massKg: 1e20,
    radiusMeters: 0,
    positionMeters: { x: 0, y: 0, z: 0 },
    velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
  }),
  createPreviewTestBody({
    id: 'draft',
    massKg: 1,
    radiusMeters: 0,
    positionMeters: { x: 10, y: 0, z: 0 },
    velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
  }),
];
const request: TrajectoryPreviewRequest = {
  version: ORBIT_PREVIEW_PROTOCOL_VERSION,
  type: 'trajectoryPreviewRequest',
  requestId: 'request-1',
  draftRevision: 4,
  bodies: [...bodies],
  draftBodyIds: ['draft'],
  referenceBodyId: 'reference',
  durationSeconds: 1,
  sampleCount: 2,
};

class FakePreviewWorker implements OrbitPreviewWorkerTarget {
  readonly listeners = new Map<WorkerEventType, Set<EventListener>>();
  postedMessage: TrajectoryPreviewRequest | null = null;
  terminated = false;

  constructor(private readonly immediateResponse?: unknown) {}

  addEventListener(type: WorkerEventType, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(message: TrajectoryPreviewRequest): void {
    this.postedMessage = message;
    if (this.immediateResponse !== undefined) {
      this.emit('message', new MessageEvent('message', { data: this.immediateResponse }));
    }
  }

  removeEventListener(type: WorkerEventType, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: WorkerEventType, event: Event): void {
    this.listeners.get(type)?.forEach((listener) => {
      listener(event);
    });
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}

const result: TrajectoryPreviewResponse = {
  version: ORBIT_PREVIEW_PROTOCOL_VERSION,
  type: 'trajectoryPreviewResult',
  requestId: 'request-1',
  draftRevision: 4,
  durationSeconds: 1,
  tracks: [
    {
      bodyId: 'draft',
      points: [
        { timeSeconds: 0, positionMeters: { x: 10, y: 0, z: 0 } },
        { timeSeconds: 1, positionMeters: { x: 10, y: 0, z: 0 } },
      ],
    },
  ],
  risk: { kind: 'stable', bodyId: null, otherBodyId: null, timeSeconds: null },
  closestApproachMeters: 10,
};

describe('requestTrajectoryPreview', () => {
  it('监听完成后再发送，并在同步成功响应后完整清理', async () => {
    const worker = new FakePreviewWorker(result);

    await expect(
      requestTrajectoryPreview(request, { createWorker: () => worker }),
    ).resolves.toEqual(result);
    expect(worker.postedMessage).toEqual(request);
    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount()).toBe(0);
  });

  it('取消待决请求会终止 Worker 并返回 AbortError', async () => {
    const worker = new FakePreviewWorker();
    const abortController = new AbortController();
    const pending = requestTrajectoryPreview(request, {
      signal: abortController.signal,
      createWorker: () => worker,
    });

    abortController.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount()).toBe(0);
  });

  it('已取消信号不会创建 Worker', async () => {
    const abortController = new AbortController();
    abortController.abort();
    let created = false;

    await expect(
      requestTrajectoryPreview(request, {
        signal: abortController.signal,
        createWorker: () => {
          created = true;
          return new FakePreviewWorker();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(created).toBe(false);
  });

  it('Worker 构造同步抛错时返回 Promise rejection', async () => {
    let pending!: Promise<TrajectoryPreviewResult>;

    expect(() => {
      pending = requestTrajectoryPreview(request, {
        createWorker: () => {
          throw new Error('worker construction failed');
        },
      });
    }).not.toThrow();
    await expect(pending).rejects.toThrow('worker construction failed');
  });

  it('拒绝其他草稿修订的响应', async () => {
    const worker = new FakePreviewWorker({ ...result, draftRevision: 5 });

    await expect(requestTrajectoryPreview(request, { createWorker: () => worker })).rejects.toThrow(
      '错误请求',
    );
    expect(worker.terminated).toBe(true);
  });

  it('拒绝与请求时长不一致的结构合法响应', async () => {
    const worker = new FakePreviewWorker({ ...result, durationSeconds: 2 });

    await expect(requestTrajectoryPreview(request, { createWorker: () => worker })).rejects.toThrow(
      '时长与请求不一致',
    );
    expect(worker.terminated).toBe(true);
  });
});
