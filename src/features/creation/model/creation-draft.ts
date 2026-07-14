import type { BodyState } from '../../../physics/protocol/schemas';
import type { CreationSnapshot } from './creation-types';

function cloneBody(body: BodyState): BodyState {
  return {
    ...body,
    positionMeters: { ...body.positionMeters },
    velocityMetersPerSecond: { ...body.velocityMetersPerSecond },
  };
}

export function captureCreationSnapshot(
  bodies: readonly BodyState[],
  bodyRevision: number,
  bodySnapshotSimulationTimeSeconds: number,
  simulationTimeSeconds: number,
): CreationSnapshot {
  if (bodySnapshotSimulationTimeSeconds !== simulationTimeSeconds) {
    throw new Error('正式模拟快照尚未追上暂停时间');
  }
  if (!Number.isSafeInteger(bodyRevision) || bodyRevision < 0) {
    throw new RangeError('bodyRevision 必须是非负安全整数');
  }

  return {
    bodies: bodies.map(cloneBody),
    bodyRevision,
    simulationTimeSeconds: bodySnapshotSimulationTimeSeconds,
  };
}
