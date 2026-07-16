import type {
  BodyState,
  PositionMeters,
  VelocityMetersPerSecond,
} from '../../../physics/protocol/schemas';

export type CreationPresetId =
  'star' | 'rocky-planet' | 'gas-giant' | 'moon' | 'black-hole' | 'asteroid-cluster';

export interface CreationSnapshot {
  readonly bodies: readonly BodyState[];
  readonly bodyRevision: number;
  readonly simulationTimeSeconds: number;
}

export interface CreationPlacement {
  readonly phase: 'dragging' | 'placed';
  readonly positionMeters: PositionMeters;
  readonly velocityMetersPerSecond: VelocityMetersPerSecond;
}

export interface CreationPreset {
  readonly id: CreationPresetId;
  readonly label: string;
  readonly typeLabel: string;
  readonly color: number;
  readonly massKg: number;
  readonly radiusMeters: number;
  readonly bodyCount: number;
  readonly spinAngularMomentumKgMetersSquaredPerSecond: Readonly<
    BodyState['spinAngularMomentumKgMetersSquaredPerSecond']
  >;
  readonly momentOfInertiaFactor: BodyState['momentOfInertiaFactor'];
  readonly materialLayers: readonly BodyState['materialLayers'][number][];
  readonly collisionModel: BodyState['collisionModel'];
}

export interface CreationDraft {
  readonly bodies: readonly BodyState[];
  readonly placement: CreationPlacement;
  readonly preset: CreationPreset;
  readonly referenceBodyId: string | null;
}

export interface CreationTrajectoryPoint {
  readonly timeSeconds: number;
  readonly positionMeters: PositionMeters;
}

export interface CreationTrajectoryTrack {
  readonly bodyId: string;
  readonly points: readonly CreationTrajectoryPoint[];
}

export type CreationRisk =
  | { readonly kind: 'stable' }
  | {
      readonly kind: 'collision';
      readonly bodyId: string;
      readonly otherBodyId: string;
      readonly timeSeconds: number;
    }
  | { readonly kind: 'escape'; readonly bodyId: string };

export interface CreationPreview {
  readonly tracks: readonly CreationTrajectoryTrack[];
  readonly risk: CreationRisk;
  readonly durationSeconds: number;
  readonly closestApproachMeters: number | null;
}

export interface CreationOverlayState {
  readonly enabled: boolean;
  readonly cameraMode: 'creation' | 'preserve';
  readonly interactive: boolean;
  readonly draftBodies: readonly BodyState[];
  readonly placement: CreationPlacement | null;
  readonly preview: CreationPreview | null;
  readonly previewPending: boolean;
  readonly color: number;
}
