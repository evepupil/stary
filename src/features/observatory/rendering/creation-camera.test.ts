import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import {
  applyCreationCameraView,
  captureCreationCameraState,
  computeCreationCameraView,
  restoreCreationCameraState,
  type CreationCameraControls,
} from './creation-camera';

function createControls(): CreationCameraControls {
  return {
    maxDistance: 80,
    minDistance: 2,
    target: new Vector3(3, -2, 1),
  };
}

describe('creation camera', () => {
  it.each([9 / 16, 1, 16 / 9])('为宽高比 %s 生成垂直创建平面的有限俯视构图', (aspect) => {
    const view = computeCreationCameraView(aspect);
    const viewDirection = new Vector3(
      view.target.x - view.position.x,
      view.target.y - view.position.y,
      view.target.z - view.position.z,
    ).normalize();

    expect(Object.values(view.position).every(Number.isFinite)).toBe(true);
    expect(view.position.z).toBeGreaterThan(view.target.z);
    expect(Math.abs(viewDirection.dot(new Vector3(0, 0, 1)))).toBeCloseTo(1, 12);
  });

  it('从侧视相机进入创建俯视并能精确恢复旧构图', () => {
    const camera = new PerspectiveCamera(45, 16 / 9, 0.25, 900);
    camera.position.set(18, 4, 0.001);
    camera.up.set(0, 0, 1);
    const controls = createControls();
    camera.lookAt(controls.target);
    const stored = captureCreationCameraState(camera, controls);

    applyCreationCameraView(camera, controls);
    const creationDirection = controls.target.clone().sub(camera.position).normalize();
    expect(Math.abs(creationDirection.dot(new Vector3(0, 0, 1)))).toBeCloseTo(1, 12);

    restoreCreationCameraState(camera, controls, stored);
    expect(camera.position.toArray()).toEqual(stored.position.toArray());
    expect(camera.quaternion.angleTo(stored.quaternion)).toBeCloseTo(0, 12);
    expect(camera.up.toArray()).toEqual(stored.up.toArray());
    expect(controls.target.toArray()).toEqual(stored.target.toArray());
    expect(camera.near).toBe(stored.near);
    expect(camera.far).toBe(stored.far);
    expect(controls.minDistance).toBe(stored.minDistance);
    expect(controls.maxDistance).toBe(stored.maxDistance);
  });
});
