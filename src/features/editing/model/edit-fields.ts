import { ASTRONOMICAL_UNIT_METERS, KILOMETERS_TO_METERS } from '../../../physics/constants';
import type { BodyState } from '../../../physics/protocol/schemas';

export interface BodyEditVectorFields {
  readonly x: string;
  readonly y: string;
  readonly z: string;
}

export interface BodyEditFields {
  readonly massKg: string;
  readonly radiusKm: string;
  readonly positionAu: BodyEditVectorFields;
  readonly velocityKmPerSecond: BodyEditVectorFields;
}

export const BODY_EDIT_FIELD_NAMES = [
  'massKg',
  'radiusKm',
  'positionAu.x',
  'positionAu.y',
  'positionAu.z',
  'velocityKmPerSecond.x',
  'velocityKmPerSecond.y',
  'velocityKmPerSecond.z',
] as const;

export type BodyEditFieldName = (typeof BODY_EDIT_FIELD_NAMES)[number];
export type BodyEditFieldErrors = Readonly<Partial<Record<BodyEditFieldName, string>>>;

export type BodyEditParseResult =
  | { readonly success: true; readonly body: BodyState }
  | { readonly success: false; readonly errors: BodyEditFieldErrors };

const DECIMAL_NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

type MutableBodyEditFieldErrors = Partial<Record<BodyEditFieldName, string>>;

interface NumberFieldOptions {
  readonly field: BodyEditFieldName;
  readonly label: string;
  readonly scaleToSi: number;
  readonly lowerBound?: 'positive' | 'nonnegative';
}

function formatNumber(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
}

function parseNumberField(
  rawValue: string,
  options: NumberFieldOptions,
  errors: MutableBodyEditFieldErrors,
): number | null {
  const valueText = rawValue.trim();
  if (valueText.length === 0) {
    errors[options.field] = `${options.label}不能为空`;
    return null;
  }
  if (!DECIMAL_NUMBER_PATTERN.test(valueText)) {
    errors[options.field] = `${options.label}必须是有限数字`;
    return null;
  }

  const value = Number(valueText);
  if (!Number.isFinite(value)) {
    errors[options.field] = `${options.label}必须是有限数字`;
    return null;
  }
  if (options.lowerBound === 'positive' && value <= 0) {
    errors[options.field] = `${options.label}必须大于 0`;
    return null;
  }
  if (options.lowerBound === 'nonnegative' && value < 0) {
    errors[options.field] = `${options.label}不能小于 0`;
    return null;
  }

  const valueSi = value * options.scaleToSi;
  if (!Number.isFinite(valueSi)) {
    errors[options.field] = `${options.label}换算后超出可用范围`;
    return null;
  }
  return valueSi;
}

export function bodyStateToEditFields(body: BodyState): BodyEditFields {
  return {
    massKg: formatNumber(body.massKg),
    radiusKm: formatNumber(body.radiusMeters / KILOMETERS_TO_METERS),
    positionAu: {
      x: formatNumber(body.positionMeters.x / ASTRONOMICAL_UNIT_METERS),
      y: formatNumber(body.positionMeters.y / ASTRONOMICAL_UNIT_METERS),
      z: formatNumber(body.positionMeters.z / ASTRONOMICAL_UNIT_METERS),
    },
    velocityKmPerSecond: {
      x: formatNumber(body.velocityMetersPerSecond.x / KILOMETERS_TO_METERS),
      y: formatNumber(body.velocityMetersPerSecond.y / KILOMETERS_TO_METERS),
      z: formatNumber(body.velocityMetersPerSecond.z / KILOMETERS_TO_METERS),
    },
  };
}

export function updateBodyEditField(
  fields: BodyEditFields,
  fieldName: BodyEditFieldName,
  value: string,
): BodyEditFields {
  switch (fieldName) {
    case 'massKg':
      return { ...fields, massKg: value };
    case 'radiusKm':
      return { ...fields, radiusKm: value };
    case 'positionAu.x':
      return { ...fields, positionAu: { ...fields.positionAu, x: value } };
    case 'positionAu.y':
      return { ...fields, positionAu: { ...fields.positionAu, y: value } };
    case 'positionAu.z':
      return { ...fields, positionAu: { ...fields.positionAu, z: value } };
    case 'velocityKmPerSecond.x':
      return {
        ...fields,
        velocityKmPerSecond: { ...fields.velocityKmPerSecond, x: value },
      };
    case 'velocityKmPerSecond.y':
      return {
        ...fields,
        velocityKmPerSecond: { ...fields.velocityKmPerSecond, y: value },
      };
    case 'velocityKmPerSecond.z':
      return {
        ...fields,
        velocityKmPerSecond: { ...fields.velocityKmPerSecond, z: value },
      };
  }
}

export function parseBodyEditFields(
  originalBody: BodyState,
  fields: BodyEditFields,
): BodyEditParseResult {
  const errors: MutableBodyEditFieldErrors = {};
  const massKg = parseNumberField(
    fields.massKg,
    { field: 'massKg', label: '质量', lowerBound: 'positive', scaleToSi: 1 },
    errors,
  );
  const radiusMeters = parseNumberField(
    fields.radiusKm,
    {
      field: 'radiusKm',
      label: '半径',
      lowerBound: 'nonnegative',
      scaleToSi: KILOMETERS_TO_METERS,
    },
    errors,
  );
  const positionX = parseNumberField(
    fields.positionAu.x,
    { field: 'positionAu.x', label: 'X 位置', scaleToSi: ASTRONOMICAL_UNIT_METERS },
    errors,
  );
  const positionY = parseNumberField(
    fields.positionAu.y,
    { field: 'positionAu.y', label: 'Y 位置', scaleToSi: ASTRONOMICAL_UNIT_METERS },
    errors,
  );
  const positionZ = parseNumberField(
    fields.positionAu.z,
    { field: 'positionAu.z', label: 'Z 位置', scaleToSi: ASTRONOMICAL_UNIT_METERS },
    errors,
  );
  const velocityX = parseNumberField(
    fields.velocityKmPerSecond.x,
    {
      field: 'velocityKmPerSecond.x',
      label: 'X 速度',
      scaleToSi: KILOMETERS_TO_METERS,
    },
    errors,
  );
  const velocityY = parseNumberField(
    fields.velocityKmPerSecond.y,
    {
      field: 'velocityKmPerSecond.y',
      label: 'Y 速度',
      scaleToSi: KILOMETERS_TO_METERS,
    },
    errors,
  );
  const velocityZ = parseNumberField(
    fields.velocityKmPerSecond.z,
    {
      field: 'velocityKmPerSecond.z',
      label: 'Z 速度',
      scaleToSi: KILOMETERS_TO_METERS,
    },
    errors,
  );

  if (
    massKg === null ||
    radiusMeters === null ||
    positionX === null ||
    positionY === null ||
    positionZ === null ||
    velocityX === null ||
    velocityY === null ||
    velocityZ === null
  ) {
    return { success: false, errors };
  }

  return {
    success: true,
    body: {
      id: originalBody.id,
      massKg,
      radiusMeters,
      positionMeters: { x: positionX, y: positionY, z: positionZ },
      velocityMetersPerSecond: { x: velocityX, y: velocityY, z: velocityZ },
    },
  };
}
