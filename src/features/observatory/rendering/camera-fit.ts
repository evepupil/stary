export const OBSERVATORY_VERTICAL_FOV_DEGREES = 42;

export function computeCameraFitDistance(
  sceneHalfExtent: number,
  aspect: number,
  verticalFovDegrees = OBSERVATORY_VERTICAL_FOV_DEGREES,
  padding = 1.12,
): number {
  assertPositiveFinite(sceneHalfExtent, 'sceneHalfExtent');
  assertPositiveFinite(aspect, 'aspect');
  assertFov(verticalFovDegrees);
  if (!Number.isFinite(padding) || padding < 1) {
    throw new RangeError('padding 必须是至少 1 的有限数');
  }

  const tangent = Math.tan((verticalFovDegrees * Math.PI) / 360);
  const paddedExtent = sceneHalfExtent * padding;
  const verticalDistance = paddedExtent / tangent;
  const horizontalDistance = paddedExtent / (tangent * aspect);
  return Math.max(verticalDistance, horizontalDistance);
}

export function computeMinimumBillboardWorldRadius(
  distanceFromCamera: number,
  viewportHeightPixels: number,
  minimumRadiusPixels: number,
  verticalFovDegrees = OBSERVATORY_VERTICAL_FOV_DEGREES,
): number {
  assertPositiveFinite(distanceFromCamera, 'distanceFromCamera');
  assertPositiveFinite(viewportHeightPixels, 'viewportHeightPixels');
  if (!Number.isFinite(minimumRadiusPixels) || minimumRadiusPixels < 0) {
    throw new RangeError('minimumRadiusPixels 必须是非负有限数');
  }
  assertFov(verticalFovDegrees);

  const visibleWorldHeight =
    2 * distanceFromCamera * Math.tan((verticalFovDegrees * Math.PI) / 360);
  return (visibleWorldHeight * minimumRadiusPixels) / viewportHeightPixels;
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} 必须是正有限数`);
  }
}

function assertFov(verticalFovDegrees: number): void {
  if (
    !Number.isFinite(verticalFovDegrees) ||
    verticalFovDegrees <= 0 ||
    verticalFovDegrees >= 180
  ) {
    throw new RangeError('verticalFovDegrees 必须在 0 到 180 度之间');
  }
}
