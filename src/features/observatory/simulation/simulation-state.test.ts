import { describe, expect, it } from 'vitest';

import type { BodyState, WorkerToMainMessage } from '../../../physics/protocol/schemas';
import { PHYSICS_PROTOCOL_VERSION } from '../../../physics/protocol/schemas';
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
  version: PHYSICS_PROTOCOL_VERSION,
  sessionId: 'test-session',
  sequence: 0,
  simulationTimeSeconds: 0,
} as const;

describe('applyWorkerMessage', () => {
  it('把 ready 和 status 映射为可操作的运行状态', () => {
    const initial = createInitialSimulationState(bodies, 86_400);
    const ready = applyWorkerMessage(initial, { ...envelope, type: 'ready', bodyRevision: 0 });
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
    const message: Extract<WorkerToMainMessage, { type: 'state' }> = {
      ...envelope,
      sequence: 2,
      simulationTimeSeconds: 3_600,
      type: 'state',
      bodyRevision: 0,
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
      bodySnapshotSimulationTimeSeconds: 3_600,
      simulationTimeSeconds: 3_600,
      latestAppliedSequence: 2,
      latestStateSequence: 2,
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

  it('成功替换重置守恒基线并拒绝旧修订延迟帧', () => {
    const initial = createInitialSimulationState(bodies, 1);
    const previousDiagnostics = {
      totalEnergyJoules: -1,
      totalLinearMomentumKgMetersPerSecond: { x: 0, y: 0, z: 0 },
      totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 1 },
    } as const;
    const previous = {
      ...initial,
      phase: 'ready',
      runState: 'paused',
      diagnostics: previousDiagnostics,
      baselineDiagnostics: previousDiagnostics,
      latestAppliedSequence: 2,
      latestStateSequence: 2,
    } as const;
    const replacementBodies: BodyState[] = [
      ...bodies,
      {
        id: 'planet',
        massKg: 1e20,
        radiusMeters: 1_000,
        positionMeters: { x: 2, y: 0, z: 0 },
        velocityMetersPerSecond: { x: 0, y: 2, z: 0 },
      },
    ];
    const replacementDiagnostics = {
      ...previousDiagnostics,
      totalEnergyJoules: -2,
    };
    const replaced = applyWorkerMessage(previous, {
      ...envelope,
      sequence: 3,
      simulationTimeSeconds: 7_200,
      type: 'bodiesReplaced',
      bodyRevision: 1,
      bodies: replacementBodies,
      diagnostics: replacementDiagnostics,
    });

    expect(replaced).toMatchObject({
      bodies: replacementBodies,
      diagnostics: replacementDiagnostics,
      baselineDiagnostics: replacementDiagnostics,
      bodyRevision: 1,
      bodySnapshotSimulationTimeSeconds: 7_200,
      latestAppliedSequence: 3,
      latestStateSequence: 2,
      runState: 'paused',
      simulationTimeSeconds: 7_200,
    });

    const stale = applyWorkerMessage(replaced, {
      ...envelope,
      sequence: 4,
      simulationTimeSeconds: 7_200,
      type: 'state',
      bodyRevision: 0,
      bodies: [...bodies],
      diagnostics: previousDiagnostics,
    });
    expect(stale).toBe(replaced);
  });

  it('可恢复错误保持 phase，不可恢复错误进入 error phase', () => {
    const ready = { ...createInitialSimulationState(bodies, 1), phase: 'ready' } as const;
    const recoverable = applyWorkerMessage(ready, {
      ...envelope,
      type: 'error',
      code: 'invalidState',
      message: '请先暂停',
      recoverable: true,
      requestSequence: 0,
    });
    const fatal = applyWorkerMessage(ready, {
      ...envelope,
      type: 'error',
      code: 'integrationFailed',
      message: '积分失败',
      recoverable: false,
      requestSequence: null,
    });

    expect(recoverable.phase).toBe('ready');
    expect(recoverable.runState).toBe('paused');
    expect(recoverable.error?.message).toContain('invalidState');
    expect(fatal.phase).toBe('error');
    expect(fatal.error?.message).toContain('integrationFailed');
  });

  it('status 和 error 只更新显示时间，不改变当前 bodies 对应的快照时间', () => {
    const ready = {
      ...createInitialSimulationState(bodies, 1),
      phase: 'ready',
      bodySnapshotSimulationTimeSeconds: 10,
      simulationTimeSeconds: 10,
    } as const;
    const status = applyWorkerMessage(ready, {
      ...envelope,
      sequence: 1,
      simulationTimeSeconds: 20,
      type: 'status',
      runState: 'paused',
      timeScale: 1,
    });
    const error = applyWorkerMessage(status, {
      ...envelope,
      sequence: 2,
      simulationTimeSeconds: 30,
      type: 'error',
      code: 'bodySnapshotConflict',
      message: '快照时间冲突',
      recoverable: true,
      requestSequence: 1,
    });

    expect(status).toMatchObject({
      bodySnapshotSimulationTimeSeconds: 10,
      simulationTimeSeconds: 20,
    });
    expect(error).toMatchObject({
      bodySnapshotSimulationTimeSeconds: 10,
      simulationTimeSeconds: 30,
    });
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
