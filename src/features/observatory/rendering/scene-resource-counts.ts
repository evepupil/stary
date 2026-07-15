import { Light, Material, Texture, type Object3D } from 'three';

export interface SceneResourceCounts {
  readonly geometries: number;
  readonly lights: number;
  readonly materials: number;
  readonly objects: number;
  readonly renderTargets: number;
  readonly textures: number;
}

export function collectSceneResourceCounts(root: Object3D): SceneResourceCounts {
  const geometries = new Set<object>();
  const materials = new Set<object>();
  const textures = new Set<object>();
  let lights = 0;
  let objects = 0;

  root.traverse((object) => {
    objects += 1;
    if (object instanceof Light) {
      lights += 1;
    }
    if ('geometry' in object && typeof object.geometry === 'object' && object.geometry !== null) {
      geometries.add(object.geometry);
    }
    if (!('material' in object)) {
      return;
    }
    const objectMaterial = object.material;
    const entries = Array.isArray(objectMaterial) ? objectMaterial : [objectMaterial];
    for (const material of entries) {
      if (!(material instanceof Material)) {
        continue;
      }
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof Texture) {
          textures.add(value);
        }
      }
    }
  });

  return {
    geometries: geometries.size,
    lights,
    materials: materials.size,
    objects,
    renderTargets: 0,
    textures: textures.size,
  };
}
