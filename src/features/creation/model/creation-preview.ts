import type { TrajectoryPreviewResult } from '../../../physics/preview';
import type { CreationPreview } from './creation-types';

export function toCreationPreview(result: TrajectoryPreviewResult): CreationPreview {
  const risk =
    result.risk.kind === 'stable'
      ? ({ kind: 'stable' } as const)
      : result.risk.kind === 'escape'
        ? ({ kind: 'escape', bodyId: result.risk.bodyId } as const)
        : ({
            kind: 'collision',
            bodyId: result.risk.bodyId,
            otherBodyId: result.risk.otherBodyId,
            timeSeconds: result.risk.timeSeconds,
          } as const);

  return {
    closestApproachMeters: result.closestApproachMeters,
    durationSeconds: result.durationSeconds,
    risk,
    tracks: result.tracks,
  };
}
