import { AmbientLight, Group, Mesh, MeshBasicMaterial, SphereGeometry, Texture } from 'three';
import { describe, expect, it } from 'vitest';

import { collectSceneResourceCounts } from './scene-resource-counts';

describe('scene resource counts', () => {
  it('按对象身份统计共享几何、材质、纹理和灯光', () => {
    const root = new Group();
    const geometry = new SphereGeometry(1, 8, 6);
    const texture = new Texture();
    const surface = new MeshBasicMaterial({ map: texture });
    const overlay = new MeshBasicMaterial({ alphaMap: texture, transparent: true });
    const first = new Mesh(geometry, surface);
    const second = new Mesh(geometry, [surface, overlay]);
    const light = new AmbientLight();
    root.add(first, second, light);

    expect(collectSceneResourceCounts(root)).toEqual({
      geometries: 1,
      lights: 1,
      materials: 2,
      objects: 4,
      renderTargets: 0,
      textures: 1,
    });

    root.remove(second);
    expect(collectSceneResourceCounts(root)).toEqual({
      geometries: 1,
      lights: 1,
      materials: 1,
      objects: 3,
      renderTargets: 0,
      textures: 1,
    });

    geometry.dispose();
    surface.dispose();
    overlay.dispose();
    texture.dispose();
  });
});
