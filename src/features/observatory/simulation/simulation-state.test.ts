import { describe, expect, it } from 'vitest';

import type { BodyState, WorkerToMainMessage } from '../../../physics/protocol/schemas';
import {
  applyControllerFatalError,
  applyWorkerMessage,
  createInitialSimulationState,
} from './simulation-state';

const bodies: readonly BodyState[] = [
  {
    id: 'earth',
    massKg: 5.9722e24,
    radiusMeters: 6_371_000,
    positionMeters: { x: 1, y: 0, z: 0 },
    velocityMetersPerSecond: { x: 0, y: 1, z: 0 },
  },
];

const envelope = {
  version: 1,
  sessionId: 'test-session',
  sequence: 0,
  simulationTimeSeconds: 0,
} as const;

describe('applyWorkerMessage', () => {
  it('把 ready 和 status 映射为可操作的运行状态', () => {
    const initial = createInitialSimulationState(bodies, 86_400);
    const ready = applyWorkerMessage(initial, { ...envelope, type: 'ready' });
    const running = applyWorkerMessage(ready, {
      ...envelope,
      sequence: 1,
      type: 'status',
      runState: 'running',
      timeScale: 3_600,
    });

    expect(ready).toMatchObject({ phase: 'ready', runState: 'initialized' });
    expect(running).toMatchObject({
      phase: 'ready',
      runState: 'running',
      timeScale: 3_600,
    });
  });

  it('用 state 原子替换天体、诊断和模拟时间', () => {
    const initial = createInitialSimulationState(bodies, 1);
    const nextBodies: BodyState[] = [
      {
        id: 'earth',
        massKg: 5.9722e24,
        radiusMeters: 6_371_000,
        positionMeters: { x: 0, y: 1, z: 0 },
        velocityMetersPerSecond: { x: 0, y: 1, z: 0 },
      },
    ];
    const message: WorkerToMainMessage = {
      ...envelope,
      sequence: 2,
      simulationTimeSeconds: 3_600,
      type: 'state',
      bodies: nextBodies,
      diagnostics: {
        totalEnergyJoules: -1,
        totalLinearMomentumKgMetersPerSecond: { x: 0, y: 0, z: 0 },
        totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 1 },
      },
    };

    expect(applyWorkerMessage(initial, message)).toMatchObject({
      phase: 'ready',
      runState: 'paused',
      bodies: nextBodies,
      diagnostics: message.diagnostics,
      baselineDiagnostics: message.diagnostics,
      simulationTimeSeconds: 3_600,
    });
    expect(applyWorkerMessage({ ...initial, runState: 'running' }, message).runState).toBe(
      'running',
    );

    const baselineDiagnostics = {
      ...message.diagnostics,
      totalEnergyJoules: -2,
    };
    expect(
      applyWorkerMessage({ ...initial, baselineDiagnostics }, message).baselineDiagnostics,
    ).toBe(baselineDiagnostics);
  });

  it('可恢复错误保持 phase，不可恢复错误进入 error phase', () => {
    const ready = { ...createInitialSimulationState(bodies, 1), phase: 'ready' } as const;
    const recoverable = applyWorkerMessage(ready, {
      ...envelope,
      type: 'error',
      code: 'invalidState',
      message: '请先暂停',
      recoverable: true,
    });
    const fatal = applyWorkerMessage(ready, {
      ...envelope,
      type: 'error',
      code: 'integrationFailed',
      message: '积分失败',
      recoverable: false,
    });

    expect(recoverable.phase).toBe('ready');
    expect(recoverable.runState).toBe('paused');
    expect(recoverable.error?.message).toContain('invalidState');
    expect(fatal.phase).toBe('error');
    expect(fatal.error?.message).toContain('integrationFailed');
  });
});

describe('applyControllerFatalError', () => {
  it('停止运行和待决命令，同时保留最后一帧可观测数据', () => {
    const initial = createInitialSimulationState(bodies, 86_400);
    const diagnostics = {
      totalEnergyJoules: -1,
      totalLinearMomentumKgMetersPerSecond: { x: 0, y: 0, z: 0 },
      totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 1 },
    } as const;
    const running = {
      ...initial,
      phase: 'ready',
      runState: 'running',
      diagnostics,
      simulationTimeSeconds: 3_600,
    } as const;
    const error = new Error('Physics Worker 运行错误');

    const failed = applyControllerFatalError(running, error);

    expect(failed).toMatchObject({
      phase: 'error',
      runState: 'paused',
      commandPending: false,
      bodies,
      diagnostics,
      simulationTimeSeconds: 3_600,
    });
    expect(failed.error).toBe(error);
  });
});
