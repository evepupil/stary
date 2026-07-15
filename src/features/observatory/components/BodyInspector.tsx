import { Pencil, Trash2 } from 'lucide-react';

import type { BodyState, PhysicsDiagnostics } from '../../../physics/protocol/schemas';
import { celestialColorToCss, getCelestialCatalogEntry } from '../catalog';
import { findOrbitParent } from '../rendering/orbit-parent';
import {
  calculateRelativeSpeedMetersPerSecond,
  createDiagnosticsViewModel,
  formatDistance,
  formatMass,
  formatSpeed,
} from '../simulation';

interface BodyInspectorProps {
  readonly baselineDiagnostics: PhysicsDiagnostics | null;
  readonly body: BodyState | null;
  readonly bodies: readonly BodyState[];
  readonly diagnostics: PhysicsDiagnostics | null;
  readonly actionsDisabled?: boolean;
  readonly onDeleteBody?: (bodyId: string) => void;
  readonly onEditBody?: (bodyId: string) => void;
}

function vectorMagnitude(vector: { readonly x: number; readonly y: number; readonly z: number }) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

export function BodyInspector({
  baselineDiagnostics,
  body,
  bodies,
  diagnostics,
  actionsDisabled = false,
  onDeleteBody,
  onEditBody,
}: BodyInspectorProps) {
  if (body === null) {
    return (
      <div className="panel-content empty-inspector">
        <p>选择一个天体查看实时数据</p>
      </div>
    );
  }

  const distance = vectorMagnitude(body.positionMeters);
  const metadata = getCelestialCatalogEntry(body.id);
  const parent = findOrbitParent(body, bodies);
  const speed = calculateRelativeSpeedMetersPerSecond(body, parent);
  const speedReferenceLabel =
    parent === null
      ? '质心系速度'
      : `相对${getCelestialCatalogEntry(parent.id)?.name ?? parent.id}速度`;
  const diagnosticViewModel =
    diagnostics === null || baselineDiagnostics === null
      ? null
      : createDiagnosticsViewModel(diagnostics, baselineDiagnostics);

  return (
    <div className="panel-content">
      <div className="panel-heading">
        <p>观测数据</p>
        <span>SI</span>
      </div>
      <div className="inspector-title">
        <span
          className="body-swatch"
          style={{ backgroundColor: celestialColorToCss(metadata?.color ?? 0xaeb8bd) }}
        />
        <div>
          <h2>{metadata?.name ?? body.id}</h2>
          <p>{metadata?.type ?? '未知天体'}</p>
        </div>
      </div>
      <dl className="measurement-list">
        <div>
          <dt>质量</dt>
          <dd>{formatMass(body.massKg)}</dd>
        </div>
        <div>
          <dt>平均半径</dt>
          <dd>{formatDistance(body.radiusMeters)}</dd>
        </div>
        <div>
          <dt>质心距离</dt>
          <dd>{formatDistance(distance)}</dd>
        </div>
        <div>
          <dt>{speedReferenceLabel}</dt>
          <dd>{formatSpeed(speed)}</dd>
        </div>
      </dl>
      <div className="diagnostics-block">
        <p>系统守恒量</p>
        <div>
          <span>总能量</span>
          <strong>{diagnosticViewModel?.totalEnergy.valueLabel ?? '等待状态'}</strong>
          <small>{`相对漂移 ${diagnosticViewModel?.totalEnergy.driftLabel ?? '--'}`}</small>
        </div>
        <div>
          <span>角动量</span>
          <strong>{diagnosticViewModel?.totalAngularMomentum.valueLabel ?? '等待状态'}</strong>
          <small>{`相对漂移 ${diagnosticViewModel?.totalAngularMomentum.driftLabel ?? '--'}`}</small>
        </div>
      </div>
      {onEditBody !== undefined || onDeleteBody !== undefined ? (
        <div className="inspector-actions">
          {onEditBody !== undefined ? (
            <button
              disabled={actionsDisabled}
              onClick={() => {
                onEditBody(body.id);
              }}
              type="button"
            >
              <Pencil aria-hidden="true" size={14} />
              <span>编辑参数</span>
            </button>
          ) : null}
          {onDeleteBody !== undefined ? (
            <button
              className="danger-button"
              data-body-action="delete"
              disabled={actionsDisabled}
              onClick={() => {
                onDeleteBody(body.id);
              }}
              type="button"
            >
              <Trash2 aria-hidden="true" size={14} />
              <span>删除天体</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
