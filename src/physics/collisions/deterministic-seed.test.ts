import { describe, expect, it } from 'vitest';

import { createDeterministicCollisionSeed } from './deterministic-seed';
import { compareUtf8 } from './stable-order';

const baseInput = {
  eventId: 'event-001',
  firstParentId: 'earth',
  secondParentId: 'theia',
  fragmentKind: 'major' as const,
  fragmentOrdinal: 0,
};

describe('确定性碰撞 seed', () => {
  it('固定编码结果并允许跨语言复现', () => {
    expect(createDeterministicCollisionSeed(baseInput)).toBe('eacc158242dbdccd');
    expect(
      createDeterministicCollisionSeed({
        ...baseInput,
        eventId: '事件-月球',
        firstParentId: '天体甲',
        secondParentId: '天体乙',
        fragmentKind: 'dust',
        fragmentOrdinal: 42,
      }),
    ).toBe('20ddfe712606e49f');
  });

  it('父体交换不改变结果', () => {
    expect(
      createDeterministicCollisionSeed({
        ...baseInput,
        firstParentId: baseInput.secondParentId,
        secondParentId: baseInput.firstParentId,
      }),
    ).toBe(createDeterministicCollisionSeed(baseInput));
    const repeated = Array.from({ length: 100 }, () => createDeterministicCollisionSeed(baseInput));
    expect(new Set(repeated)).toEqual(new Set([repeated[0]]));
  });

  it('非 BMP 标识按 UTF-8 字节排序', () => {
    expect(compareUtf8('\uE000', '\u{10000}')).toBe(-1);
    const seed = createDeterministicCollisionSeed({
      ...baseInput,
      firstParentId: '\uE000',
      secondParentId: '\u{10000}',
    });
    expect(seed).toBe('5874b7d591f99919');
    expect(seed).toBe(
      createDeterministicCollisionSeed({
        ...baseInput,
        firstParentId: '\u{10000}',
        secondParentId: '\uE000',
      }),
    );
  });

  it('事件、碎片类型和序号都会改变结果', () => {
    const seed = createDeterministicCollisionSeed(baseInput);
    expect(createDeterministicCollisionSeed({ ...baseInput, eventId: 'event-002' })).not.toBe(seed);
    expect(createDeterministicCollisionSeed({ ...baseInput, fragmentKind: 'tracer' })).not.toBe(
      seed,
    );
    expect(createDeterministicCollisionSeed({ ...baseInput, fragmentOrdinal: 1 })).not.toBe(seed);
  });
});
