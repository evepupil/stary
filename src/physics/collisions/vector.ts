import type { CollisionVector } from './schemas';

interface CompensatedSum {
  compensation: number;
  sum: number;
}

function addCompensated(state: CompensatedSum, value: number): void {
  const corrected = value - state.compensation;
  const next = state.sum + corrected;
  state.compensation = next - state.sum - corrected;
  state.sum = next;
}

export function compensatedSum(values: Iterable<number>): number {
  const state = { compensation: 0, sum: 0 };
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new RangeError('求和输入必须是有限数');
    }
    addCompensated(state, value);
  }
  if (!Number.isFinite(state.sum)) {
    throw new RangeError('求和结果超出有限数范围');
  }
  return state.sum;
}

export function add(left: CollisionVector, right: CollisionVector): CollisionVector {
  return finiteVector({ x: left.x + right.x, y: left.y + right.y, z: left.z + right.z });
}

export function subtract(left: CollisionVector, right: CollisionVector): CollisionVector {
  return finiteVector({ x: left.x - right.x, y: left.y - right.y, z: left.z - right.z });
}

export function scale(vector: CollisionVector, factor: number): CollisionVector {
  if (!Number.isFinite(factor)) {
    throw new RangeError('向量缩放因子必须是有限数');
  }
  return finiteVector({ x: vector.x * factor, y: vector.y * factor, z: vector.z * factor });
}

export function dot(left: CollisionVector, right: CollisionVector): number {
  return finiteNumber(left.x * right.x + left.y * right.y + left.z * right.z);
}

export function cross(left: CollisionVector, right: CollisionVector): CollisionVector {
  return finiteVector({
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  });
}

export function magnitude(vector: CollisionVector): number {
  return finiteNumber(Math.hypot(vector.x, vector.y, vector.z));
}

export function sumVectors(vectors: Iterable<CollisionVector>): CollisionVector {
  const x: number[] = [];
  const y: number[] = [];
  const z: number[] = [];
  for (const vector of vectors) {
    x.push(vector.x);
    y.push(vector.y);
    z.push(vector.z);
  }
  return { x: compensatedSum(x), y: compensatedSum(y), z: compensatedSum(z) };
}

export function finiteNumber(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError('物理计算结果超出有限数范围');
  }
  return value;
}

function finiteVector(vector: CollisionVector): CollisionVector {
  finiteNumber(vector.x);
  finiteNumber(vector.y);
  finiteNumber(vector.z);
  return vector;
}
