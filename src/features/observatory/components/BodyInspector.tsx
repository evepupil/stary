import type { BodyState, PhysicsDiagnostics } from '../../../physics/protocol/schemas';
import { createDiagnosticsViewModel, formatDistance, formatMass, formatSpeed } from '../simulation';

interface BodyInspectorProps {
  readonly baselineDiagnostics: PhysicsDiagnostics | null;
  readonly body: BodyState | null;
  readonly diagnostics: PhysicsDiagnostics | null;
}

const bodyNames: Record<string, string> = {
  sun: '太阳',
  earth: '地球',
};

function vectorMagnitude(vector: { readonly x: number; readonly y: number; readonly z: number }) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

export function BodyInspector({ baselineDiagnostics, body, diagnostics }: BodyInspectorProps) {
  if (body === null) {
    return (
      <div className="panel-content empty-inspector">
        <p>选择一个天体查看实时数据</p>
      </div>
    );
  }

  const distance = vectorMagnitude(body.positionMeters);
  const speed = vectorMagnitude(body.velocityMetersPerSecond);
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
        <span className={`body-swatch body-swatch-${body.id}`} />
        <div>
          <h2>{bodyNames[body.id] ?? body.id}</h2>
          <p>{body.id === 'sun' ? '系统主恒星' : '质心参考系'}</p>
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
          <dt>轨道速度</dt>
          <dd>{formatSpeed(speed)}</dd>
        </div>
      </dl>
      <div className="diagnostics-block">
        <p>系统守恒量</p>
        <div>
          <span>总能量</span>
          <strong>{diagnosticViewModel?.totalEnergy.valueLabel ?? '等待状态'}</strong>
          <small>{`相对漂移 ${diagnosticViewModel?.totalEnergy.relativeDriftLabel ?? '--'}`}</small>
        </div>
        <div>
          <span>角动量</span>
          <strong>{diagnosticViewModel?.totalAngularMomentum.valueLabel ?? '等待状态'}</strong>
          <small>{`相对漂移 ${diagnosticViewModel?.totalAngularMomentum.relativeDriftLabel ?? '--'}`}</small>
        </div>
      </div>
    </div>
  );
}
