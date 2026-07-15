import type { TrajectoryPreviewRequest, TrajectoryPreviewResult } from './schemas';

export function validateTrajectoryPreviewResultForRequest(
  result: TrajectoryPreviewResult,
  request: TrajectoryPreviewRequest,
): TrajectoryPreviewResult {
  if (result.requestId !== request.requestId || result.draftRevision !== request.draftRevision) {
    throw new Error('轨道预览 Worker 返回了错误请求的结果');
  }
  if (result.durationSeconds !== request.durationSeconds) {
    throw new Error('轨道预览 Worker 返回的时长与请求不一致');
  }

  const expectedTrackIds = new Set(request.draftBodyIds);
  const actualTrackIds = new Set<string>();
  for (const track of result.tracks) {
    if (actualTrackIds.has(track.bodyId)) {
      throw new Error(`轨道预览 Worker 返回了重复轨迹：${track.bodyId}`);
    }
    if (!expectedTrackIds.has(track.bodyId)) {
      throw new Error(`轨道预览 Worker 返回了未请求的轨迹：${track.bodyId}`);
    }
    actualTrackIds.add(track.bodyId);
    validateTrackPoints(track.bodyId, track.points, request);
  }
  for (const bodyId of request.draftBodyIds) {
    if (!actualTrackIds.has(bodyId)) {
      throw new Error(`轨道预览 Worker 缺少轨迹：${bodyId}`);
    }
  }

  validateRisk(result, request);
  return result;
}

function validateTrackPoints(
  bodyId: string,
  points: TrajectoryPreviewResult['tracks'][number]['points'],
  request: TrajectoryPreviewRequest,
): void {
  if (points.length !== request.sampleCount) {
    throw new Error(
      `轨道预览 ${bodyId} 的点数异常：预期 ${String(request.sampleCount)}，实际 ${String(points.length)}`,
    );
  }
  if (points[0]?.timeSeconds !== 0) {
    throw new Error(`轨道预览 ${bodyId} 的首点时刻必须为 0`);
  }
  if (points.at(-1)?.timeSeconds !== request.durationSeconds) {
    throw new Error(`轨道预览 ${bodyId} 的末点时刻必须等于请求时长`);
  }

  let previousTimeSeconds = -1;
  for (const point of points) {
    if (point.timeSeconds < 0 || point.timeSeconds > request.durationSeconds) {
      throw new Error(`轨道预览 ${bodyId} 包含超出请求范围的时刻`);
    }
    if (point.timeSeconds <= previousTimeSeconds) {
      throw new Error(`轨道预览 ${bodyId} 的时刻必须严格递增`);
    }
    previousTimeSeconds = point.timeSeconds;
  }
}

function validateRisk(result: TrajectoryPreviewResult, request: TrajectoryPreviewRequest): void {
  const risk = result.risk;
  if (risk.kind === 'stable') {
    return;
  }

  const draftBodyIds = new Set(request.draftBodyIds);
  if (!draftBodyIds.has(risk.bodyId)) {
    throw new Error(`轨道预览风险引用了非草稿天体：${risk.bodyId}`);
  }
  if (risk.timeSeconds > request.durationSeconds) {
    throw new Error('轨道预览风险时刻超出请求范围');
  }

  if (risk.kind === 'escape') {
    if (
      request.referenceBodyId === null ||
      risk.otherBodyId !== request.referenceBodyId ||
      risk.timeSeconds !== request.durationSeconds
    ) {
      throw new Error('轨道预览逃逸风险与请求参考天体或末端时刻不一致');
    }
    return;
  }

  const bodyIds = new Set(request.bodies.map((body) => body.id));
  if (!bodyIds.has(risk.otherBodyId) || risk.otherBodyId === risk.bodyId) {
    throw new Error('轨道预览碰撞风险引用了无效天体');
  }
}
