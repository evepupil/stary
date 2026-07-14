export interface ScreenMarkerCandidate {
  readonly bodyId: string;
  readonly x: number;
  readonly y: number;
  readonly depth: number;
  readonly priority: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export function selectVisibleScreenMarkers(
  candidates: readonly ScreenMarkerCandidate[],
  minimumSeparationPixels: number,
): readonly ScreenMarkerCandidate[] {
  assertNonNegativeFinite(minimumSeparationPixels, 'minimumSeparationPixels');

  const accepted: ScreenMarkerCandidate[] = [];
  const sorted = candidates.toSorted(
    (left, right) =>
      right.priority - left.priority ||
      left.depth - right.depth ||
      left.bodyId.localeCompare(right.bodyId),
  );

  for (const candidate of sorted) {
    if (!isFiniteMarker(candidate)) {
      continue;
    }
    const overlaps = accepted.some(
      (visible) =>
        Math.hypot(candidate.x - visible.x, candidate.y - visible.y) < minimumSeparationPixels,
    );
    if (!overlaps) {
      accepted.push(candidate);
    }
  }

  return accepted;
}

export function pickNearestScreenMarker(
  markers: readonly ScreenMarkerCandidate[],
  pointer: ScreenPoint,
  hitRadiusPixels: number,
): string | null {
  assertNonNegativeFinite(hitRadiusPixels, 'hitRadiusPixels');
  if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) {
    return null;
  }

  let nearest: ScreenMarkerCandidate | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const marker of markers) {
    const markerDistance = Math.hypot(pointer.x - marker.x, pointer.y - marker.y);
    if (
      markerDistance <= hitRadiusPixels &&
      (markerDistance < nearestDistance ||
        (markerDistance === nearestDistance &&
          (nearest === null || marker.priority > nearest.priority)))
    ) {
      nearest = marker;
      nearestDistance = markerDistance;
    }
  }
  return nearest?.bodyId ?? null;
}

function isFiniteMarker(candidate: ScreenMarkerCandidate): boolean {
  return (
    Number.isFinite(candidate.x) &&
    Number.isFinite(candidate.y) &&
    Number.isFinite(candidate.depth) &&
    Number.isFinite(candidate.priority)
  );
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} 必须是非负有限数`);
  }
}
