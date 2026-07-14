import type { PerspectiveCamera, Quaternion, Vector3 } from 'three';

import { computeOverviewCameraFrame } from './camera-focus';
import type { ScenePosition } from './coordinates';

export interface CreationCameraControls {
  maxDistance: number;
  minDistance: number;
  readonly target: Vector3;
}

export interface CreationCameraView {
  readonly far: number;
  readonly maxDistance: number;
  readonly minDistance: number;
  readonly near: number;
  readonly position: ScenePosition;
  readonly target: ScenePosition;
  readonly up: ScenePosition;
}

export interface StoredCreationCameraState {
  readonly far: number;
  readonly maxDistance: number;
  readonly minDistance: number;
  readonly near: number;
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly target: Vector3;
  readonly up: Vector3;
}

export function computeCreationCameraView(aspect: number): CreationCameraView {
  const overview = computeOverviewCameraFrame(aspect);
  return {
    far: Math.max(overview.distance * 12, overview.halfExtent * 64, 320),
    maxDistance: Math.max(overview.distance * 4, overview.halfExtent * 12),
    minDistance: Math.max(1e-6, overview.halfExtent * 0.05),
    near: Math.max(1e-7, overview.distance * 1e-5),
    position: {
      x: overview.target.x,
      y: overview.target.y,
      z: overview.target.z + overview.distance,
    },
    target: overview.target,
    up: { x: 0, y: 1, z: 0 },
  };
}

export function captureCreationCameraState(
  camera: PerspectiveCamera,
  controls: CreationCameraControls,
): StoredCreationCameraState {
  return {
    far: camera.far,
    maxDistance: controls.maxDistance,
    minDistance: controls.minDistance,
    near: camera.near,
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    target: controls.target.clone(),
    up: camera.up.clone(),
  };
}

export function applyCreationCameraView(
  camera: PerspectiveCamera,
  controls: CreationCameraControls,
): void {
  const view = computeCreationCameraView(camera.aspect);
  controls.target.set(view.target.x, view.target.y, view.target.z);
  controls.minDistance = view.minDistance;
  controls.maxDistance = view.maxDistance;
  camera.position.set(view.position.x, view.position.y, view.position.z);
  camera.up.set(view.up.x, view.up.y, view.up.z);
  camera.near = view.near;
  camera.far = view.far;
  camera.lookAt(controls.target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

export function restoreCreationCameraState(
  camera: PerspectiveCamera,
  controls: CreationCameraControls,
  state: StoredCreationCameraState,
): void {
  controls.target.copy(state.target);
  controls.minDistance = state.minDistance;
  controls.maxDistance = state.maxDistance;
  camera.position.copy(state.position);
  camera.quaternion.copy(state.quaternion);
  camera.up.copy(state.up);
  camera.near = state.near;
  camera.far = state.far;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}
