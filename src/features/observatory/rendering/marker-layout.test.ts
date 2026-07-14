import { describe, expect, it } from 'vitest';

import {
  pickNearestScreenMarker,
  selectVisibleScreenMarkers,
  type ScreenMarkerCandidate,
} from './marker-layout';

function marker(bodyId: string, x: number, priority: number, depth = 0): ScreenMarkerCandidate {
  return { bodyId, x, y: 100, priority, depth };
}

describe('screen marker layout', () => {
  it('重叠时保留优先级最高的定位环', () => {
    const visible = selectVisibleScreenMarkers(
      [marker('sun', 100, 50), marker('earth', 108, 100), marker('mars', 160, 10)],
      18,
    );

    expect(visible.map((entry) => entry.bodyId)).toEqual(['earth', 'mars']);
  });

  it('同优先级时使用深度和 id 得到稳定结果', () => {
    const visible = selectVisibleScreenMarkers(
      [marker('venus', 100, 10, 0.2), marker('mercury', 101, 10, 0.1)],
      18,
    );

    expect(visible.map((entry) => entry.bodyId)).toEqual(['mercury']);
  });

  it('点击返回命中半径内最近的可见中心', () => {
    const markers = [marker('earth', 100, 20), marker('mars', 140, 10)];

    expect(pickNearestScreenMarker(markers, { x: 112, y: 100 }, 20)).toBe('earth');
    expect(pickNearestScreenMarker(markers, { x: 120, y: 100 }, 10)).toBeNull();
  });
});
