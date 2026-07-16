import { describe, expect, it } from 'vitest';

import { computeCollisionLedger } from '../collisions/conservation';
import { parseMainToWorkerMessage, parseWorkerToMainMessage } from './parse-message';
import { createPhysicsStateFromSnapshot } from './physics-state';
import {
  MAX_MAJOR_BODY_COUNT,
  MAX_TIME_SCALE,
  PHYSICS_PROTOCOL_VERSION,
  type BodyState,
  type PhysicsState,
} from './schemas';

const envelope = {
  version: PHYSICS_PROTOCOL_VERSION,
  sessionId: 'session-a',
  sequence: 0,
  simulationTimeSeconds: 0,
} as const;

const diagnostics = {
  totalEnergyJoules: -2.65e33,
  totalLinearMomentumKgMetersPerSecond: { x: 0, y: 0, z: 0 },
  totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 2.66e40 },
} as const;

function createBody(id: string): BodyState {
  return {
    id,
    massKg: 1.98847e30,
    radiusMeters: 696_340_000,
    positionMeters: { x: 0, y: 0, z: 0 },
    velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
    spinAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 1 },
    momentOfInertiaFactor: 0.33,
    materialLayers: [{ material: 'silicate', massFraction: 1 }],
    collisionModel: 'gravitySolid',
  };
}

function createState(bodies: readonly BodyState[]): PhysicsState {
  return createPhysicsStateFromSnapshot({ bodies, diagnostics });
}

describe('parseMainToWorkerMessage', () => {
  it.each([
    { ...envelope, type: 'initialize', bodies: [createBody('sun'), createBody('earth')] },
    { ...envelope, sequence: 1, type: 'start' },
    { ...envelope, sequence: 2, type: 'pause' },
    { ...envelope, sequence: 3, type: 'step', stepSeconds: 60 },
    { ...envelope, sequence: 4, type: 'setTimeScale', timeScale: 86_400 },
    {
      ...envelope,
      sequence: 5,
      type: 'replaceBodies',
      expectedBodyRevision: 0,
      expectedSimulationTimeSeconds: 0,
      bodies: [createBody('sun'), createBody('planet')],
    },
    { ...envelope, sequence: 6, type: 'dispose' },
  ])('接受合法 $type 命令', (message) => {
    expect(parseMainToWorkerMessage(message)).toEqual(message);
  });

  it('拒绝缺少公共字段的消息', () => {
    expect(() =>
      parseMainToWorkerMessage({
        version: PHYSICS_PROTOCOL_VERSION,
        sessionId: 'session-a',
        sequence: 0,
        type: 'start',
      }),
    ).toThrow();
  });

  it.each([1, 2])('严格拒绝旧协议 v%s', (version) => {
    expect(() => parseMainToWorkerMessage({ ...envelope, version, type: 'start' })).toThrow();
    expect(() =>
      parseWorkerToMainMessage({
        ...envelope,
        version,
        type: 'ready',
        replyToSequence: 0,
        bodyRevision: 0,
      }),
    ).toThrow();
  });

  it.each([
    { sequence: 1, simulationTimeSeconds: 0 },
    { sequence: 0, simulationTimeSeconds: 1 },
  ])('拒绝 initialize 握手使用非零序号或时间', ({ sequence, simulationTimeSeconds }) => {
    expect(() =>
      parseMainToWorkerMessage({
        ...envelope,
        sequence,
        simulationTimeSeconds,
        type: 'initialize',
        bodies: [createBody('sun')],
      }),
    ).toThrow();
  });

  it.each([
    'spinAngularMomentumKgMetersSquaredPerSecond',
    'momentOfInertiaFactor',
    'materialLayers',
    'collisionModel',
  ] as const)('拒绝 BodyState 缺少 %s', (field) => {
    const body: Record<string, unknown> = { ...createBody('sun') };
    Reflect.deleteProperty(body, field);
    expect(() =>
      parseMainToWorkerMessage({ ...envelope, type: 'initialize', bodies: [body] }),
    ).toThrow();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    '拒绝非有限位置 %s',
    (invalidNumber) => {
      expect(() =>
        parseMainToWorkerMessage({
          ...envelope,
          type: 'initialize',
          bodies: [
            {
              ...createBody('sun'),
              positionMeters: { x: invalidNumber, y: 0, z: 0 },
            },
          ],
        }),
      ).toThrow();
    },
  );

  it.each([0, -1])('拒绝非正质量 %s', (massKg) => {
    expect(() =>
      parseMainToWorkerMessage({
        ...envelope,
        type: 'initialize',
        bodies: [{ ...createBody('sun'), massKg }],
      }),
    ).toThrow();
  });

  it('保留零半径点质量兼容并拒绝负半径', () => {
    expect(() =>
      parseMainToWorkerMessage({
        ...envelope,
        type: 'initialize',
        bodies: [{ ...createBody('point-mass'), radiusMeters: 0 }],
      }),
    ).not.toThrow();
    expect(() =>
      parseMainToWorkerMessage({
        ...envelope,
        type: 'initialize',
        bodies: [{ ...createBody('sun'), radiusMeters: -1 }],
      }),
    ).toThrow();
  });

  it('拒绝非法时间、步长、倍率和序号', () => {
    expect(() =>
      parseMainToWorkerMessage({ ...envelope, simulationTimeSeconds: -1, type: 'pause' }),
    ).toThrow();
    expect(() => parseMainToWorkerMessage({ ...envelope, type: 'step', stepSeconds: 0 })).toThrow();
    expect(() =>
      parseMainToWorkerMessage({ ...envelope, type: 'setTimeScale', timeScale: 0 }),
    ).toThrow();
    expect(() => parseMainToWorkerMessage({ ...envelope, sequence: 0.5, type: 'pause' })).toThrow();
  });

  it('接受最大时间倍率并拒绝超过协议上限', () => {
    expect(() =>
      parseMainToWorkerMessage({
        ...envelope,
        type: 'setTimeScale',
        timeScale: MAX_TIME_SCALE,
      }),
    ).not.toThrow();
    expect(() =>
      parseMainToWorkerMessage({
        ...envelope,
        type: 'setTimeScale',
        timeScale: MAX_TIME_SCALE + 1,
      }),
    ).toThrow();
  });

  it('拒绝重复天体 id', () => {
    expect(() =>
      parseMainToWorkerMessage({
        ...envelope,
        type: 'initialize',
        bodies: [createBody('duplicate'), createBody('duplicate')],
      }),
    ).toThrow('天体 id 重复');
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    '拒绝非法 expectedBodyRevision %s',
    (expectedBodyRevision) => {
      expect(() =>
        parseMainToWorkerMessage({
          ...envelope,
          sequence: 1,
          type: 'replaceBodies',
          expectedBodyRevision,
          expectedSimulationTimeSeconds: 0,
          bodies: [createBody('sun')],
        }),
      ).toThrow();
    },
  );

  it('接受 512 个主要天体并拒绝第 513 个', () => {
    const maximumBodies = Array.from({ length: MAX_MAJOR_BODY_COUNT }, (_, index) =>
      createBody(`body-${String(index)}`),
    );
    expect(() =>
      parseMainToWorkerMessage({ ...envelope, type: 'initialize', bodies: maximumBodies }),
    ).not.toThrow();
    expect(() =>
      parseMainToWorkerMessage({
        ...envelope,
        type: 'initialize',
        bodies: [...maximumBodies, createBody('body-512')],
      }),
    ).toThrow();
  });

  it('拒绝协议外字段', () => {
    expect(() =>
      parseMainToWorkerMessage({
        ...envelope,
        type: 'start',
        threeScene: { children: [] },
      }),
    ).toThrow();
  });
});

describe('parseWorkerToMainMessage', () => {
  it.each([
    { ...envelope, type: 'ready', replyToSequence: 0, bodyRevision: 0 },
    {
      ...envelope,
      sequence: 1,
      simulationTimeSeconds: 60,
      type: 'state',
      replyToSequence: 3,
      requestedTargetSimulationTimeSeconds: 60,
      bodyRevision: 0,
      state: createState([createBody('sun')]),
    },
    {
      ...envelope,
      sequence: 2,
      type: 'bodiesReplaced',
      replyToSequence: 5,
      bodyRevision: 1,
      state: createState([createBody('sun'), createBody('planet')]),
    },
    {
      ...envelope,
      sequence: 3,
      type: 'status',
      replyToSequence: null,
      runState: 'running',
      timeScale: 86_400,
    },
    {
      ...envelope,
      sequence: 4,
      type: 'error',
      replyToSequence: 5,
      code: 'bodyReplacementFailed',
      message: '替换失败',
      recoverable: true,
    },
    { ...envelope, sequence: 5, type: 'disposed', replyToSequence: 6 },
  ])('接受合法 $type 响应', (message) => {
    expect(parseWorkerToMainMessage(message)).toEqual(message);
  });

  it('拒绝 state 响应中的重复天体 id', () => {
    const state = createState([createBody('sun')]);
    expect(() =>
      parseWorkerToMainMessage({
        ...envelope,
        type: 'state',
        replyToSequence: null,
        requestedTargetSimulationTimeSeconds: 0,
        bodyRevision: 0,
        state: {
          ...state,
          majorBodies: [createBody('duplicate'), createBody('duplicate')],
        },
      }),
    ).toThrow('天体 id 重复');
  });

  it('拒绝 state 的目标时间与实际时间不一致', () => {
    expect(() =>
      parseWorkerToMainMessage({
        ...envelope,
        type: 'state',
        replyToSequence: 3,
        requestedTargetSimulationTimeSeconds: 1,
        bodyRevision: 0,
        state: createState([createBody('sun')]),
      }),
    ).toThrow('state 必须精确到达请求目标时间');
  });

  it('拒绝 ready 握手缺少固定回执序号', () => {
    expect(() =>
      parseWorkerToMainMessage({ ...envelope, type: 'ready', bodyRevision: 0 }),
    ).toThrow();
    expect(() =>
      parseWorkerToMainMessage({
        ...envelope,
        type: 'ready',
        replyToSequence: null,
        bodyRevision: 0,
      }),
    ).toThrow();
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    '拒绝非法 replyToSequence %s',
    (replyToSequence) => {
      expect(() =>
        parseWorkerToMainMessage({
          ...envelope,
          sequence: 1,
          type: 'error',
          replyToSequence,
          code: 'bodySnapshotConflict',
          message: '快照过期',
          recoverable: true,
        }),
      ).toThrow();
    },
  );

  it('允许后台响应使用 null replyToSequence 并拒绝缺少该字段', () => {
    expect(() =>
      parseWorkerToMainMessage({
        ...envelope,
        sequence: 1,
        type: 'error',
        replyToSequence: null,
        code: 'invalidCommand',
        message: '消息无法解析',
        recoverable: true,
      }),
    ).not.toThrow();
    expect(() =>
      parseWorkerToMainMessage({
        ...envelope,
        sequence: 1,
        type: 'error',
        code: 'invalidCommand',
        message: '消息无法解析',
        recoverable: true,
      }),
    ).toThrow();
  });

  it('接受原子碰撞批次并拒绝事件与账本错配', () => {
    const first = {
      ...createBody('first'),
      massKg: 10,
      radiusMeters: 1,
      positionMeters: { x: -1, y: 0, z: 0 },
      velocityMetersPerSecond: { x: 1, y: 0, z: 0 },
    };
    const second = {
      ...createBody('second'),
      massKg: 10,
      radiusMeters: 1,
      positionMeters: { x: 1, y: 0, z: 0 },
      velocityMetersPerSecond: { x: -1, y: 0, z: 0 },
    };
    const eventState = { majorBodies: [first, second], tracers: [], dustCohorts: [] };
    const ledger = computeCollisionLedger({
      eventId: 'event-1',
      simulationTimeSeconds: 10,
      before: eventState,
      after: eventState,
      dissipation: {
        heatJoules: 0,
        deformationJoules: 0,
        fractureJoules: 0,
        radiationJoules: 0,
      },
      participantBodyIds: ['first', 'second'],
    });
    const state = {
      ...createState([first, second]),
      cumulativeCollisionLedger: {
        resolvedEventCount: 1,
        accumulatedDissipation: ledger.dissipation,
      },
    };
    const batch = {
      ...envelope,
      sequence: 8,
      simulationTimeSeconds: 10,
      type: 'collisionBatchResolved',
      replyToSequence: 7,
      collisionBatchSequence: 1,
      requestedTargetSimulationTimeSeconds: 12,
      contactTimeSeconds: 10,
      runState: 'paused',
      bodyRevisionBefore: 0,
      bodyRevisionAfter: 1,
      events: [
        {
          eventId: 'event-1',
          modelVersion: ledger.modelVersion,
          participantBodyIds: ['first', 'second'],
          classification: 'hitAndRun',
          specificImpactEnergyJoulesPerKg: 1,
          disruptionThresholdJoulesPerKg: 2,
          normalizedImpactEnergy: 0.5,
          impactAngleRadians: 0,
          modelExtrapolated: false,
          majorRemnantIds: ['first', 'second'],
          tracerIds: [],
          dustCohortIds: [],
        },
      ],
      ledgerDelta: [ledger],
      state,
    } as const;

    expect(() => parseWorkerToMainMessage(batch)).not.toThrow();
    expect(() =>
      parseWorkerToMainMessage({
        ...batch,
        ledgerDelta: [{ ...ledger, eventId: 'other-event' }],
      }),
    ).toThrow('一一对应');
    expect(() =>
      parseWorkerToMainMessage({
        ...batch,
        ledgerDelta: [{ ...ledger, simulationTimeSeconds: 9 }],
      }),
    ).toThrow('账本时间');
    expect(() =>
      parseWorkerToMainMessage({
        ...batch,
        events: [{ ...batch.events[0], modelVersion: 'other-model' }],
      }),
    ).toThrow('同一模型版本');
    expect(() =>
      parseWorkerToMainMessage({
        ...batch,
        ledgerDelta: [{ ...ledger, passed: false }],
      }),
    ).toThrow('守恒检查');
    expect(() =>
      parseWorkerToMainMessage({
        ...batch,
        events: [...batch.events, { ...batch.events[0], eventId: 'event-2' }],
        ledgerDelta: [...batch.ledgerDelta, { ...ledger, eventId: 'event-2' }],
        state: {
          ...batch.state,
          cumulativeCollisionLedger: {
            ...batch.state.cumulativeCollisionLedger,
            resolvedEventCount: 2,
          },
        },
      }),
    ).toThrow('不能共享');
  });
});
