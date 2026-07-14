import { describe, expect, it } from 'vitest';

import { SessionSequenceGate } from './session-sequence-gate';

describe('SessionSequenceGate', () => {
  it('接受当前 session 严格递增的序号并允许跳号', () => {
    const gate = new SessionSequenceGate('session-a');

    expect(gate.accept({ sessionId: 'session-a', sequence: 0 }).accepted).toBe(true);
    expect(gate.accept({ sessionId: 'session-a', sequence: 5 })).toEqual({
      accepted: true,
      lastAcceptedSequence: 5,
      sessionId: 'session-a',
    });
  });

  it('拒绝重复和倒退序号且不推进门状态', () => {
    const gate = new SessionSequenceGate('session-a');
    gate.accept({ sessionId: 'session-a', sequence: 4 });

    expect(gate.accept({ sessionId: 'session-a', sequence: 4 })).toMatchObject({
      accepted: false,
      lastAcceptedSequence: 4,
      reason: 'nonIncreasingSequence',
    });
    expect(gate.accept({ sessionId: 'session-a', sequence: 3 })).toMatchObject({
      accepted: false,
      lastAcceptedSequence: 4,
      reason: 'nonIncreasingSequence',
    });
    expect(gate.lastAcceptedSequence).toBe(4);
  });

  it('拒绝其他 session 的消息', () => {
    const gate = new SessionSequenceGate('session-a');

    expect(gate.accept({ sessionId: 'session-old', sequence: 100 })).toEqual({
      accepted: false,
      lastAcceptedSequence: null,
      reason: 'sessionMismatch',
      sessionId: 'session-a',
    });
  });

  it('Worker 重启后重置序号并永久拒绝旧 session', () => {
    const gate = new SessionSequenceGate('session-a');
    gate.accept({ sessionId: 'session-a', sequence: 42 });

    gate.resetForWorkerRestart('session-b');

    expect(gate.currentSessionId).toBe('session-b');
    expect(gate.lastAcceptedSequence).toBeNull();
    expect(gate.accept({ sessionId: 'session-b', sequence: 0 }).accepted).toBe(true);
    expect(gate.accept({ sessionId: 'session-a', sequence: 43 })).toMatchObject({
      accepted: false,
      reason: 'sessionMismatch',
    });
  });

  it('拒绝用相同 sessionId 声称 Worker 已重启', () => {
    const gate = new SessionSequenceGate('session-a');

    expect(() => {
      gate.resetForWorkerRestart('session-a');
    }).toThrow('必须使用从未使用过的 sessionId');
  });

  it('记录所有退役会话并拒绝 A 到 B 再回到 A', () => {
    const gate = new SessionSequenceGate('session-a');
    gate.resetForWorkerRestart('session-b');

    expect(() => {
      gate.resetForWorkerRestart('session-a');
    }).toThrow('必须使用从未使用过的 sessionId');

    expect(gate.currentSessionId).toBe('session-b');
    expect(gate.lastAcceptedSequence).toBeNull();
  });
});
