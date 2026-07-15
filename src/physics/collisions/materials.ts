import {
  materialLayersSchema,
  type AbsoluteMaterialMasses,
  type CollisionMaterial,
  type MaterialLayer,
} from './schemas';
import { compensatedSum, finiteNumber } from './vector';

export interface AbsoluteMaterialLayer {
  readonly material: CollisionMaterial;
  readonly massKg: number;
}

export interface MaterialStrippingResult {
  readonly retainedLayers: readonly AbsoluteMaterialLayer[];
  readonly ejectedLayers: readonly AbsoluteMaterialLayer[];
  readonly retainedMassKg: number;
  readonly ejectedMassKg: number;
}

function assertMass(value: number, label: string, allowZero: boolean): void {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new RangeError(`${label}必须是${allowZero ? '非负' : '正'}有限数`);
  }
}

export function materialLayerMasses(
  bodyMassKg: number,
  layerInputs: readonly MaterialLayer[],
): AbsoluteMaterialLayer[] {
  assertMass(bodyMassKg, '天体质量', false);
  const layers = materialLayersSchema.min(1).parse(layerInputs);
  let assignedMassKg = 0;
  return layers.map((layer, index) => {
    const massKg =
      index === layers.length - 1
        ? finiteNumber(bodyMassKg - assignedMassKg)
        : finiteNumber(bodyMassKg * layer.massFraction);
    if (massKg <= 0) {
      throw new RangeError('材料层换算后必须保留正质量');
    }
    assignedMassKg = finiteNumber(assignedMassKg + massKg);
    return { material: layer.material, massKg };
  });
}

export function computeAbsoluteMaterialMasses(
  bodyMassKg: number,
  layers: readonly MaterialLayer[],
): AbsoluteMaterialMasses {
  const masses = materialLayerMasses(bodyMassKg, layers);
  const byMaterial: Record<CollisionMaterial, number[]> = {
    gas: [],
    ice: [],
    silicate: [],
    iron: [],
  };
  for (const layer of masses) {
    byMaterial[layer.material].push(layer.massKg);
  }
  return {
    gas: compensatedSum(byMaterial.gas),
    ice: compensatedSum(byMaterial.ice),
    silicate: compensatedSum(byMaterial.silicate),
    iron: compensatedSum(byMaterial.iron),
  };
}

export function stripOuterMaterial(
  bodyMassKg: number,
  layerInputs: readonly MaterialLayer[],
  removedMassKg: number,
): MaterialStrippingResult {
  assertMass(bodyMassKg, '天体质量', false);
  assertMass(removedMassKg, '剥离质量', true);
  if (removedMassKg > bodyMassKg) {
    throw new RangeError('剥离质量不能超过天体质量');
  }

  const layers = materialLayerMasses(bodyMassKg, layerInputs);
  const retainedLayers: AbsoluteMaterialLayer[] = [];
  const ejectedLayers: AbsoluteMaterialLayer[] = [];
  let remainingRemovalKg = removedMassKg;

  for (const layer of layers) {
    const ejectedMassKg = Math.min(layer.massKg, remainingRemovalKg);
    const retainedMassKg = finiteNumber(layer.massKg - ejectedMassKg);
    remainingRemovalKg = finiteNumber(remainingRemovalKg - ejectedMassKg);
    if (ejectedMassKg > 0) {
      ejectedLayers.push({ material: layer.material, massKg: ejectedMassKg });
    }
    if (retainedMassKg > 0) {
      retainedLayers.push({ material: layer.material, massKg: retainedMassKg });
    }
  }

  const ejectedMassKg = compensatedSum(ejectedLayers.map((layer) => layer.massKg));
  const retainedMassKg = compensatedSum(retainedLayers.map((layer) => layer.massKg));
  if (Math.abs(ejectedMassKg - removedMassKg) > Number.EPSILON * bodyMassKg * 8) {
    throw new RangeError('材料剥离结果没有保持质量');
  }

  return { retainedLayers, ejectedLayers, retainedMassKg, ejectedMassKg };
}
