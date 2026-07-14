import { describe, expect, it } from 'vitest';

import { parseMainToWorkerMessage, parseWorkerToMainMessage } from './parse-message';
import { MAX_MAJOR_BODY_COUNT, MAX_TIME_SCALE, PHYSICS_PROTOCOL_VERSION } from './schemas';

const envelope = {
  version: PHYSICS_PROTOCOL_VERSION,
  sessionId: 'session-a',
  sequence: 0,
  simulationTimeSeconds: 0,
} as const;

function createBody(id: string) {
  return {
    id,
    massKg: 1.98847e30,
    radiusMeters: 696_340_000,
    positionMeters: { x: 0, y: 0, z: 0 },
    velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
  };
}

const diagnostics = {
  totalEnergyJoules: -2.65e33,
  totalLinearMomentumKgMetersPerSecond: { x: 0, y: 0, z: 0 },
  totalAngularMomentumKgMetersSquaredPerSecond: { x: 0, y: 0, z: 2.66e40 },
};

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

  it('拒绝未知协议版本', () => {
    expect(() => parseMainToWorkerMessage({ ...envelope, version: 1, type: 'start' })).toThrow();
    expect(() =>
      parseWorkerToMainMessage({
        ...envelope,
        version: 1,
        type: 'ready',
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

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    '拒绝非有限数 %s',
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

  it('接受零半径并拒绝负半径和负模拟时间', () => {
    expect(
      parseMainToWorkerMessage({
        ...envelope,
        type: 'initialize',
        bodies: [{ ...createBody('point-mass'), radiusMeters: 0 }],
      }),
    ).toBeDefined();
    expect(() =>
      parseMainToWorkerMessage({
        ...envelope,
        type: 'initialize',
        bodies: [{ ...createBody('sun'), radiusMeters: -1 }],
      }),
    ).toThrow();
    expect(() =>
      parseMainToWorkerMessage({ ...envelope, simulationTimeSeconds: -1, type: 'pause' }),
    ).toThrow();
  });

  it('拒绝零步长、零时间倍率和非整数 sequence', () => {
    expect(() => parseMainToWorkerMessage({ ...envelope, type: 'step', stepSeconds: 0 })).toThrow();
    expect(() =>
      parseMainToWorkerMessage({ ...envelope, type: 'setTimeScale', timeScale: 0 }),
    ).toThrow();
    expect(() => parseMainToWorkerMessage({ ...envelope, sequence: 0.5, type: 'pause' })).toThrow();
  });

  it('接受最大时间倍率并拒绝超过协议上限的命令和状态', () => {
    expect(() =>
      parseMainToWorkerMessage({
        ...envelope,
        type: 'setTimeScale',
        timeScale: MAX_TIME_SCALE,
      }),
    ).not.toThrow();
    expect(() =>
      parseWorkerToMainMessage({
        ...envelope,
        type: 'status',
        runState: 'running',
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
    expect(() =>
      parseWorkerToMainMessage({
        ...envelope,
        type: 'status',
        runState: 'running',
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

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    '拒绝非法 expectedSimulationTimeSeconds %s',
    (expectedSimulationTimeSeconds) => {
      expect(() =>
        parseMainToWorkerMessage({
          ...envelope,
          sequence: 1,
          type: 'replaceBodies',
          expectedBodyRevision: 0,
          expectedSimulationTimeSeconds,
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
      parseMainToWorkerMessage({
        ...envelope,
        type: 'initialize',
        bodies: maximumBodies,
      }),
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
    { ...envelope, type: 'ready', bodyRevision: 0 },
    {
      ...envelope,
      sequence: 1,
      type: 'state',
      bodyRevision: 0,
      bodies: [createBody('sun')],
      diagnostics,
    },
    {
      ...envelope,
      sequence: 2,
      type: 'bodiesReplaced',
      bodyRevision: 1,
      bodies: [createBody('sun'), createBody('planet')],
      diagnostics,
    },
    { ...envelope, sequence: 3, type: 'status', runState: 'running', timeScale: 86_400 },
    {
      ...envelope,
      sequence: 4,
      type: 'error',
      code: 'bodyReplacementFailed',
      message: '替换失败',
      recoverable: true,
      requestSequence: 5,
    },
    { ...envelope, sequence: 5, type: 'disposed' },
  ])('接受合法 $type 响应', (message) => {
    expect(parseWorkerToMainMessage(message)).toEqual(message);
  });

  it('拒绝 state 响应中的重复天体 id', () => {
    expect(() =>
      parseWorkerToMainMessage({
        ...envelope,
        type: 'state',
        bodyRevision: 0,
        bodies: [createBody('duplicate'), createBody('duplicate')],
        diagnostics,
      }),
    ).toThrow('天体 id 重复');
  });

  it.each([
    { sequence: 1, simulationTimeSeconds: 0 },
    { sequence: 0, simulationTimeSeconds: 1 },
  ])('拒绝 ready 握手使用非零序号或时间', ({ sequence, simulationTimeSeconds }) => {
    expect(() =>
      parseWorkerToMainMessage({
        ...envelope,
        sequence,
        simulationTimeSeconds,
        type: 'ready',
        bodyRevision: 0,
      }),
    ).toThrow();
  });

  it('拒绝响应中的非有限状态值', () => {
    expect(() =>
      parseWorkerToMainMessage({
        ...envelope,
        type: 'state',
        bodyRevision: 0,
        bodies: [createBody('sun')],
        diagnostics: { ...diagnostics, totalEnergyJoules: Number.POSITIVE_INFINITY },
      }),
    ).toThrow();
  });

  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    '拒绝非法 bodiesReplaced bodyRevision %s',
    (bodyRevision) => {
      expect(() =>
        parseWorkerToMainMessage({
          ...envelope,
          sequence: 1,
          type: 'bodiesReplaced',
          bodyRevision,
          bodies: [createBody('sun')],
          diagnostics,
        }),
      ).toThrow();
    },
  );

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    '拒绝非法 error requestSequence %s',
    (requestSequence) => {
      expect(() =>
        parseWorkerToMainMessage({
          ...envelope,
          sequence: 1,
          type: 'error',
          code: 'bodySnapshotConflict',
          message: '快照过期',
          recoverable: true,
          requestSequence,
        }),
      ).toThrow();
    },
  );

  it('允许无法关联到已解析命令的 error 使用 null requestSequence', () => {
    expect(() =>
      parseWorkerToMainMessage({
        ...envelope,
        sequence: 1,
        type: 'error',
        code: 'invalidCommand',
        message: '消息无法解析',
        recoverable: true,
        requestSequence: null,
      }),
    ).not.toThrow();
  });

  it('拒绝缺少 requestSequence 的 error', () => {
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
});
