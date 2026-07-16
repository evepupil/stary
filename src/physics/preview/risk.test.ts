import { describe, expect, it } from 'vitest';

import { GRAVITATIONAL_CONSTANT_SI } from '../constants';
import type { BodyState } from '../protocol/schemas';
import {
  computeSweptClosestApproach,
  computeSweptCollisionFraction,
  isEscapingReferenceBody,
} from './risk';
import { createPreviewTestBody } from './test-helpers';

const referenceBody: BodyState = createPreviewTestBody({
  id: 'reference',
  massKg: 1e20,
  radiusMeters: 0,
  positionMeters: { x: 0, y: 0, z: 0 },
  velocityMetersPerSecond: { x: 0, y: 0, z: 0 },
});

describe('trajectory preview risk calculations', () => {
  it('发现两个端点之间的扫掠最近距离', () => {
    const approach = computeSweptClosestApproach(
      { x: -10, y: 2, z: 0 },
      { x: 10, y: 2, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
    );

    expect(approach.distanceMeters).toBeCloseTo(2, 12);
    expect(approach.segmentFraction).toBeCloseTo(0.5, 12);
  });

  it('静止相对位置使用采样点距离', () => {
    expect(
      computeSweptClosestApproach(
        { x: 3, y: 4, z: 0 },
        { x: 3, y: 4, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
      ),
    ).toEqual({ distanceMeters: 5, segmentFraction: 0 });
  });

  it('返回扫掠线段首次接触碰撞半径的比例', () => {
    expect(
      computeSweptCollisionFraction(
        { x: -10, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        2,
      ),
    ).toBeCloseTo(0.4, 12);
    expect(
      computeSweptCollisionFraction(
        { x: -10, y: 3, z: 0 },
        { x: 10, y: 3, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        2,
      ),
    ).toBeNull();
  });

  it('只有非负二体比能且径向向外时判定逃逸', () => {
    const distanceMeters = 1e7;
    const escapeSpeed = Math.sqrt(
      (2 * GRAVITATIONAL_CONSTANT_SI * (referenceBody.massKg + 1)) / distanceMeters,
    );
    const body = (radialSpeed: number): BodyState => ({
      ...referenceBody,
      id: 'draft',
      massKg: 1,
      positionMeters: { x: distanceMeters, y: 0, z: 0 },
      velocityMetersPerSecond: { x: radialSpeed, y: 0, z: 0 },
    });

    expect(isEscapingReferenceBody(body(escapeSpeed * 0.99), referenceBody)).toBe(false);
    expect(isEscapingReferenceBody(body(escapeSpeed * 1.01), referenceBody)).toBe(true);
    expect(isEscapingReferenceBody(body(-escapeSpeed * 1.01), referenceBody)).toBe(false);
  });
});
