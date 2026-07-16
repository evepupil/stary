import { describe, expect, it, vi } from 'vitest';

import type { BodyState } from '../protocol/schemas';
import type { ReboundSimulation, ReboundSnapshot } from '../rebound/rebound-simulation';
import { OrbitPreviewRuntime } from './orbit-preview-runtime';
import {
  ORBIT_PREVIEW_PROTOCOL_VERSION,
  type TrajectoryPreviewRequest,
  type TrajectoryPreviewResponse,
} from './schemas';
import { createPreviewTestBody } from './test-helpers';

const diagnostics = {
  totalEnergyJoules: 0,
  totalLinearMomentumKgMetersPerSecond: { x: 0, y: 0, z: 0 },
  totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 0 },
} as const;
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
    positionMeters: { x: 1e7, y: 0, z: 0 },
    velocityMetersPerSecond: { x: 0, y: 1, z: 0 },
  }),
];
const request: TrajectoryPreviewRequest = {
  version: ORBIT_PREVIEW_PROTOCOL_VERSION,
  type: 'trajectoryPreviewRequest',
  requestId: 'request-1',
  draftRevision: 1,
  bodies: [...bodies],
  draftBodyIds: ['draft'],
  referenceBodyId: 'reference',
  durationSeconds: 1,
  sampleCount: 2,
};

class StaticSimulation implements ReboundSimulation {
  destroyCount = 0;
  timeSeconds = 0;

  constructor(private readonly failSnapshot = false) {}

  destroy(): void {
    this.destroyCount += 1;
  }

  integrateTo(targetTimeSeconds: number): void {
    this.timeSeconds = targetTimeSeconds;
  }

  snapshot(): ReboundSnapshot {
    if (this.failSnapshot) {
      throw new Error('preview snapshot failed');
    }
    return { bodies, diagnostics };
  }
}

function createHarness(simulation = new StaticSimulation()) {
  const closeWorker = vi.fn();
  const messages: TrajectoryPreviewResponse[] = [];
  const runtime = new OrbitPreviewRuntime({
    closeWorker,
    createSimulation: () => Promise.resolve(simulation),
    postMessage: (message) => {
      messages.push(message);
    },
  });
  return { closeWorker, messages, runtime, simulation };
}

describe('OrbitPreviewRuntime', () => {
  it('成功后发送结果、销毁 simulation 并关闭 Worker', async () => {
    const harness = createHarness();

    await harness.runtime.receive(request);

    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]).toMatchObject({
      type: 'trajectoryPreviewResult',
      requestId: 'request-1',
      draftRevision: 1,
    });
    expect(harness.simulation.destroyCount).toBe(1);
    expect(harness.closeWorker).toHaveBeenCalledOnce();
  });

  it('完整处理没有参考天体的单草稿预览', async () => {
    const harness = createHarness();

    await harness.runtime.receive({ ...request, referenceBodyId: null });

    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]).toMatchObject({
      type: 'trajectoryPreviewResult',
      requestId: 'request-1',
      draftRevision: 1,
      risk: { kind: 'stable' },
    });
    expect(harness.simulation.destroyCount).toBe(1);
    expect(harness.closeWorker).toHaveBeenCalledOnce();
  });

  it('非法请求返回无关联错误并关闭 Worker', async () => {
    const harness = createHarness();

    await harness.runtime.receive({ ...request, sampleCount: 1 });

    expect(harness.messages[0]).toMatchObject({
      type: 'trajectoryPreviewError',
      requestId: null,
      draftRevision: null,
      code: 'invalidRequest',
    });
    expect(harness.simulation.destroyCount).toBe(0);
    expect(harness.closeWorker).toHaveBeenCalledOnce();
  });

  it('预览失败保留请求关联并完成清理', async () => {
    const harness = createHarness(new StaticSimulation(true));

    await harness.runtime.receive(request);

    expect(harness.messages[0]).toMatchObject({
      type: 'trajectoryPreviewError',
      requestId: 'request-1',
      draftRevision: 1,
      code: 'previewFailed',
    });
    expect(harness.simulation.destroyCount).toBe(1);
    expect(harness.closeWorker).toHaveBeenCalledOnce();
  });

  it('messageerror 返回明确错误并只处理一次', async () => {
    const harness = createHarness();

    harness.runtime.reportMessageError();
    await harness.runtime.receive(request);

    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]).toMatchObject({ code: 'messageError' });
    expect(harness.closeWorker).toHaveBeenCalledOnce();
  });
});
