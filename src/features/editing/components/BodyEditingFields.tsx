import type { BodyEditFieldErrors, BodyEditFieldName, BodyEditFields } from '../model';

interface NumberFieldProps {
  readonly disabled: boolean;
  readonly error: string | undefined;
  readonly fieldName: BodyEditFieldName;
  readonly id: string;
  readonly label: string;
  readonly onValueChange: (fieldName: BodyEditFieldName, value: string) => void;
  readonly unit: string;
  readonly value: string;
}

interface VectorFieldDefinition {
  readonly axis: 'x' | 'y' | 'z';
  readonly fieldName: BodyEditFieldName;
  readonly label: string;
}

interface BodyEditingFieldsProps {
  readonly disabled: boolean;
  readonly errors: BodyEditFieldErrors;
  readonly fields: BodyEditFields;
  readonly name: string;
  readonly onValueChange: (fieldName: BodyEditFieldName, value: string) => void;
}

const POSITION_FIELDS = [
  { axis: 'x', fieldName: 'positionAu.x', label: 'X' },
  { axis: 'y', fieldName: 'positionAu.y', label: 'Y' },
  { axis: 'z', fieldName: 'positionAu.z', label: 'Z' },
] as const satisfies readonly VectorFieldDefinition[];

const VELOCITY_FIELDS = [
  { axis: 'x', fieldName: 'velocityKmPerSecond.x', label: 'X' },
  { axis: 'y', fieldName: 'velocityKmPerSecond.y', label: 'Y' },
  { axis: 'z', fieldName: 'velocityKmPerSecond.z', label: 'Z' },
] as const satisfies readonly VectorFieldDefinition[];

function NumberField({
  disabled,
  error,
  fieldName,
  id,
  label,
  onValueChange,
  unit,
  value,
}: NumberFieldProps) {
  const errorId = `${id}-error`;

  return (
    <label className="body-editing-field" htmlFor={id}>
      <span>{label}</span>
      <span className="body-editing-input-shell">
        <input
          aria-describedby={error === undefined ? undefined : errorId}
          aria-invalid={error !== undefined}
          autoComplete="off"
          disabled={disabled}
          id={id}
          inputMode="decimal"
          onChange={(event) => {
            onValueChange(fieldName, event.currentTarget.value);
          }}
          spellCheck={false}
          type="text"
          value={value}
        />
        <span aria-hidden="true" className="body-editing-unit">
          {unit}
        </span>
      </span>
      {error === undefined ? null : (
        <small className="body-editing-field-error" id={errorId}>
          {error}
        </small>
      )}
    </label>
  );
}

export function BodyEditingFields({
  disabled,
  errors,
  fields,
  name,
  onValueChange,
}: BodyEditingFieldsProps) {
  return (
    <div className="body-editing-fields">
      <label className="body-editing-field" htmlFor="body-edit-name">
        <span>名称</span>
        <span className="body-editing-input-shell">
          <input id="body-edit-name" readOnly type="text" value={name} />
        </span>
      </label>

      <div className="body-editing-scalar-fields">
        <NumberField
          disabled={disabled}
          error={errors.massKg}
          fieldName="massKg"
          id="body-edit-mass"
          label="质量"
          onValueChange={onValueChange}
          unit="kg"
          value={fields.massKg}
        />
        <NumberField
          disabled={disabled}
          error={errors.radiusKm}
          fieldName="radiusKm"
          id="body-edit-radius"
          label="半径"
          onValueChange={onValueChange}
          unit="km"
          value={fields.radiusKm}
        />
      </div>

      <fieldset className="body-editing-vector-fields">
        <legend>位置</legend>
        {POSITION_FIELDS.map((definition) => (
          <NumberField
            disabled={disabled}
            error={errors[definition.fieldName]}
            fieldName={definition.fieldName}
            id={`body-edit-position-${definition.axis}`}
            key={definition.fieldName}
            label={definition.label}
            onValueChange={onValueChange}
            unit="AU"
            value={fields.positionAu[definition.axis]}
          />
        ))}
      </fieldset>

      <fieldset className="body-editing-vector-fields">
        <legend>速度</legend>
        {VELOCITY_FIELDS.map((definition) => (
          <NumberField
            disabled={disabled}
            error={errors[definition.fieldName]}
            fieldName={definition.fieldName}
            id={`body-edit-velocity-${definition.axis}`}
            key={definition.fieldName}
            label={definition.label}
            onValueChange={onValueChange}
            unit="km/s"
            value={fields.velocityKmPerSecond[definition.axis]}
          />
        ))}
      </fieldset>
    </div>
  );
}
