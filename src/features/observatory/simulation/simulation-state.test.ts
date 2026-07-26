import { describe, expect, it } from 'vitest';

import type { BodyState, WorkerToMainMessage } from '../../../physics/protocol/schemas';
import { PHYSICS_PROTOCOL_VERSION } from '../../../physics/protocol/schemas';
import {
  applyControllerFatalError,
  applyWorkerMessage,
  createInitialSimulationState,
} from './simulation-state';
import {
  createTestBody,
  createTestCollisionBatchMessage,
  createTestDiagnostics,
  createTestPhysicsState,
  createTestReplacementMessage,
  createTestStateMessage,
} from './test-helpers';

const bodies: readonly BodyState[] = [
  createTestBody({
    id: 'earth',
    massKg: 5.9722e24,
    radiusMeters: 6_371_000,
    positionMeters: { x: 1, y: 0, z: 0 },
    velocityMetersPerSecond: { x: 0, y: 1, z: 0 },
  }),
];

const envelope = {
  version: PHYSICS_PROTOCOL_VERSION,
  sessionId: 'test-session',
  sequence: 0,
  simulationTimeSeconds: 0,
  replyToSequence: 0,
} as const;

describe('applyWorkerMessage', () => {
  it('把 ready 和 status 映射为可操作的运行状态', () => {
    const initial = createInitialSimulationState(bodies, 86_400);
    const ready = applyWorkerMessage(initial, { ...envelope, type: 'ready', bodyRevision: 0 });
    const running = applyWorkerMessage(ready, {
      ...envelope,
      sequence: 1,
      replyToSequence: 1,
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
      createTestBody({
        id: 'earth',
        massKg: 5.9722e24,
        radiusMeters: 6_371_000,
        positionMeters: { x: 0, y: 1, z: 0 },
        velocityMetersPerSecond: { x: 0, y: 1, z: 0 },
      }),
    ];
    const message: Extract<WorkerToMainMessage, { type: 'state' }> = createTestStateMessage(2, {
      simulationTimeSeconds: 3_600,
      bodyRevision: 0,
      bodies: nextBodies,
      replyToSequence: 2,
    });
    const diagnostics = message.state.diagnostics.activeRebound;

    expect(applyWorkerMessage(initial, message)).toMatchObject({
      phase: 'ready',
      runState: 'paused',
      bodies: nextBodies,
      physicsState: message.state,
      diagnostics,
      baselineDiagnostics: diagnostics,
      bodySnapshotSimulationTimeSeconds: 3_600,
      simulationTimeSeconds: 3_600,
      latestAppliedSequence: 2,
      latestStateSequence: 2,
    });
    expect(applyWorkerMessage({ ...initial, runState: 'running' }, message).runState).toBe(
      'running',
    );

    const baselineDiagnostics = {
      ...diagnostics,
      totalEnergyJoules: -2,
    };
    expect(
      applyWorkerMessage({ ...initial, baselineDiagnostics }, message).baselineDiagnostics,
    ).toBe(baselineDiagnostics);
  });

  it('成功替换重置守恒基线并拒绝旧修订延迟帧', () => {
    const initial = createInitialSimulationState(bodies, 1);
    const previousDiagnostics = createTestDiagnostics();
    const previous = {
      ...initial,
      phase: 'ready',
      runState: 'paused',
      diagnostics: previousDiagnostics,
      baselineDiagnostics: previousDiagnostics,
      physicsState: createTestPhysicsState(bodies),
      latestAppliedSequence: 2,
      latestStateSequence: 2,
    } as const;
    const replacementBodies: BodyState[] = [
      ...bodies,
      createTestBody({
        id: 'planet',
        massKg: 1e20,
        radiusMeters: 1_000,
        positionMeters: { x: 2, y: 0, z: 0 },
        velocityMetersPerSecond: { x: 0, y: 2, z: 0 },
      }),
    ];
    const replacementDiagnostics = {
      ...previousDiagnostics,
      totalEnergyJoules: -2,
    };
    const replacement = createTestReplacementMessage({
      sequence: 3,
      simulationTimeSeconds: 7_200,
      replyToSequence: 8,
      bodyRevision: 1,
      bodies: replacementBodies,
      totalEnergyJoules: replacementDiagnostics.totalEnergyJoules,
    });
    const replaced = applyWorkerMessage(previous, replacement);

    expect(replaced).toMatchObject({
      bodies: replacementBodies,
      physicsState: replacement.state,
      diagnostics: replacementDiagnostics,
      baselineDiagnostics: replacementDiagnostics,
      bodyRevision: 1,
      bodySnapshotSimulationTimeSeconds: 7_200,
      latestAppliedSequence: 3,
      latestStateSequence: 2,
      runState: 'paused',
      simulationTimeSeconds: 7_200,
    });

    const stale = applyWorkerMessage(
      replaced,
      createTestStateMessage(4, {
        simulationTimeSeconds: 7_200,
        bodyRevision: 0,
        bodies: [...bodies],
      }),
    );
    expect(stale).toBe(replaced);
  });

  it('碰撞批次原子替换完整物理状态，并拒绝随后到达的旧世界 state', () => {
    const initial = {
      ...createInitialSimulationState(bodies, 1),
      phase: 'ready',
      runState: 'running',
      physicsState: createTestPhysicsState(bodies),
      diagnostics: createTestDiagnostics(),
      baselineDiagnostics: createTestDiagnostics(),
      latestAppliedSequence: 2,
      latestStateSequence: 2,
    } as const;
    const remnant = createTestBody({
      id: 'collision-remnant',
      massKg: 2,
      positionMeters: { x: 5, y: 0, z: 0 },
    });
    const collision = createTestCollisionBatchMessage({
      sequence: 3,
      contactTimeSeconds: 20,
      bodyRevisionBefore: 0,
      bodyRevisionAfter: 1,
      replyToSequence: null,
      remnant,
    });

    const resolved = applyWorkerMessage(initial, collision);

    expect(resolved).toMatchObject({
      phase: 'ready',
      runState: 'paused',
      bodies: [remnant],
      physicsState: collision.state,
      diagnostics: collision.state.diagnostics.activeRebound,
      baselineDiagnostics: collision.state.diagnostics.activeRebound,
      bodyRevision: 1,
      bodySnapshotSimulationTimeSeconds: 20,
      simulationTimeSeconds: 20,
      latestAppliedSequence: 3,
      latestStateSequence: 3,
      error: null,
    });

    const stale = createTestStateMessage(4, {
      bodyRevision: 0,
      bodies,
      simulationTimeSeconds: 20,
    });
    expect(applyWorkerMessage(resolved, stale)).toBe(resolved);
  });

  it('碰撞批次保留事件、账本与碰前参与体快照，后续 state 不清除记录', () => {
    const firstParent = createTestBody({ id: 'first-parent', massKg: 1.5 });
    const secondParent = createTestBody({ id: 'second-parent', massKg: 0.5 });
    const initial = {
      ...createInitialSimulationState([firstParent, secondParent], 1),
      phase: 'ready',
      runState: 'running',
      physicsState: createTestPhysicsState([firstParent, secondParent]),
      latestAppliedSequence: 2,
      latestStateSequence: 2,
    } as const;
    const collision = createTestCollisionBatchMessage({ sequence: 3, bodyRevisionBefore: 0 });

    const resolved = applyWorkerMessage(initial, collision);

    expect(resolved.latestCollisionBatch).toMatchObject({
      collisionBatchSequence: collision.collisionBatchSequence,
      contactTimeSeconds: collision.contactTimeSeconds,
      bodyRevisionAfter: collision.bodyRevisionAfter,
      events: collision.events,
      ledgerDelta: collision.ledgerDelta,
    });
    expect(resolved.latestCollisionBatch?.participants.map((body) => body.id)).toEqual([
      'first-parent',
      'second-parent',
    ]);

    const later = applyWorkerMessage(
      resolved,
      createTestStateMessage(4, {
        bodyRevision: collision.bodyRevisionAfter,
        bodies: collision.state.majorBodies,
        simulationTimeSeconds: 30,
      }),
    );
    expect(later.latestCollisionBatch).toBe(resolved.latestCollisionBatch);
  });

  it('天体替换与 worker 重启会清除碰撞批次记录', () => {
    const collision = createTestCollisionBatchMessage({ sequence: 3, bodyRevisionBefore: 0 });
    const resolved = applyWorkerMessage(
      {
        ...createInitialSimulationState(bodies, 1),
        phase: 'ready',
        physicsState: createTestPhysicsState(bodies),
        latestAppliedSequence: 2,
        latestStateSequence: 2,
      },
      collision,
    );
    expect(resolved.latestCollisionBatch).not.toBeNull();

    const replaced = applyWorkerMessage(
      resolved,
      createTestReplacementMessage({
        sequence: 5,
        simulationTimeSeconds: 40,
        replyToSequence: 9,
        bodyRevision: collision.bodyRevisionAfter + 1,
        bodies: [createTestBody({ id: 'edited' })],
      }),
    );
    expect(replaced.latestCollisionBatch).toBeNull();

    const restarted = applyWorkerMessage(resolved, {
      version: PHYSICS_PROTOCOL_VERSION,
      sessionId: 'restarted-session',
      sequence: 0,
      simulationTimeSeconds: 0,
      replyToSequence: 0,
      type: 'ready',
      bodyRevision: 0,
    });
    expect(restarted.latestCollisionBatch).toBeNull();
  });

  it('可恢复错误保持 phase，不可恢复错误进入 error phase', () => {
    const ready = { ...createInitialSimulationState(bodies, 1), phase: 'ready' } as const;
    const recoverable = applyWorkerMessage(ready, {
      ...envelope,
      type: 'error',
      code: 'invalidState',
      message: '请先暂停',
      recoverable: true,
      replyToSequence: 0,
    });
    const fatal = applyWorkerMessage(ready, {
      ...envelope,
      type: 'error',
      code: 'integrationFailed',
      message: '积分失败',
      recoverable: false,
      replyToSequence: null,
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
      replyToSequence: 1,
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
      replyToSequence: 1,
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
    const diagnostics = createTestDiagnostics();
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
