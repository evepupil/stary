const encoder = new TextEncoder();

export function compareUtf8(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte === undefined || rightByte === undefined) {
      throw new RangeError('UTF-8 排序索引越界');
    }
    if (leftByte !== rightByte) {
      return leftByte < rightByte ? -1 : 1;
    }
  }
  if (leftBytes.length === rightBytes.length) {
    return 0;
  }
  return leftBytes.length < rightBytes.length ? -1 : 1;
}
