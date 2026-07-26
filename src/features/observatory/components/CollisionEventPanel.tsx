import { Play, TriangleAlert, X } from 'lucide-react';

import type { PhysicsState } from '../../../physics/protocol/schemas';
import {
  createCollisionEventViewModel,
  findLedgerForEvent,
  type CollisionEventViewModel,
} from '../collisions';
import { formatSimulationTime } from '../simulation';
import type { CollisionBatchRecord } from '../simulation/simulation-state';

interface CollisionEventPanelProps {
  readonly batch: CollisionBatchRecord;
  readonly physicsState: PhysicsState | null;
  readonly actionsDisabled?: boolean;
  readonly onContinue: () => void;
  readonly onDismiss: () => void;
  readonly onSelectBody: (bodyId: string) => void;
}

function CollisionEventSection({
  viewModel,
  onSelectBody,
}: {
  readonly viewModel: CollisionEventViewModel;
  readonly onSelectBody: (bodyId: string) => void;
}) {
  return (
    <section
      className="collision-event"
      data-classification={viewModel.classification}
      data-event-id={viewModel.eventId}
      data-ledger-passed={viewModel.ledgerPassed ?? 'none'}
    >
      <header className="collision-event-header">
        <strong>{viewModel.classificationLabel}</strong>
        <small>{viewModel.classificationDetailLabel}</small>
        {viewModel.modelExtrapolated ? (
          <span className="collision-extrapolated">
            <TriangleAlert aria-hidden="true" size={12} />
            超出标定范围
          </span>
        ) : null}
      </header>
      <p className="collision-participants">{viewModel.participantNames.join(' ✕ ')}</p>
      <dl className="measurement-list">
        {viewModel.contactMeasurements.map((measurement) => (
          <div key={measurement.label}>
            <dt>{measurement.label}</dt>
            <dd>{measurement.value}</dd>
          </div>
        ))}
      </dl>
      {viewModel.matterFate.length > 0 ? (
        <div className="collision-subsection">
          <p>物质去向</p>
          <dl className="measurement-list">
            {viewModel.matterFate.map((measurement) => (
              <div key={measurement.label}>
                <dt>{measurement.label}</dt>
                <dd>{measurement.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      {viewModel.dissipation.length > 0 ? (
        <div className="collision-subsection">
          <p>机械能耗散</p>
          <dl className="measurement-list">
            {viewModel.dissipation.map((measurement) => (
              <div key={measurement.label}>
                <dt>{measurement.label}</dt>
                <dd>{measurement.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      {viewModel.conservationChecks.length > 0 ? (
        <div className="collision-subsection">
          <p>守恒账本</p>
          <ul className="collision-check-list">
            {viewModel.conservationChecks.map((check) => (
              <li data-passed={check.passed} key={check.label}>
                <span>{check.label}</span>
                <small>{`相对误差 ${check.normalizedErrorLabel} / 门槛 ${check.thresholdLabel}`}</small>
                <strong>{check.passed ? '通过' : '未通过'}</strong>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="collision-subsection">
        <p>碰撞产物</p>
        <div className="collision-remnant-list">
          {viewModel.remnants.map((remnant) => (
            <button
              key={remnant.id}
              onClick={() => {
                onSelectBody(remnant.id);
              }}
              type="button"
            >
              <strong>{remnant.name}</strong>
              <small>
                {remnant.isSurvivor ? `幸存 · ${remnant.massLabel}` : remnant.massLabel}
              </small>
            </button>
          ))}
        </div>
        {viewModel.tracerCount > 0 || viewModel.dustCohortCount > 0 ? (
          <p className="collision-passive-summary">
            {`tracer ${String(viewModel.tracerCount)} 个 · 尘埃团 ${String(viewModel.dustCohortCount)} 个`}
          </p>
        ) : null}
      </div>
      <p className="collision-model-version">{`模型 ${viewModel.modelVersion}`}</p>
    </section>
  );
}

export function CollisionEventPanel({
  batch,
  physicsState,
  actionsDisabled = false,
  onContinue,
  onDismiss,
  onSelectBody,
}: CollisionEventPanelProps) {
  const viewModels = batch.events.map((event) =>
    createCollisionEventViewModel({
      event,
      ledger: findLedgerForEvent(event, batch.ledgerDelta),
      participants: batch.participants,
      state: physicsState,
    }),
  );

  return (
    <div className="panel-content collision-event-content">
      <div className="panel-heading">
        <p>碰撞事件</p>
        <span>{`${String(batch.events.length)} 起`}</span>
      </div>
      <p className="collision-contact-time">
        {`接触时刻 ${formatSimulationTime(batch.contactTimeSeconds)},模拟已暂停`}
      </p>
      {viewModels.map((viewModel) => (
        <CollisionEventSection
          key={viewModel.eventId}
          onSelectBody={onSelectBody}
          viewModel={viewModel}
        />
      ))}
      <div className="collision-actions">
        <button disabled={actionsDisabled} onClick={onContinue} type="button">
          <Play aria-hidden="true" size={14} />
          <span>继续模拟</span>
        </button>
        <button className="collision-dismiss-button" onClick={onDismiss} type="button">
          <X aria-hidden="true" size={14} />
          <span>关闭</span>
        </button>
      </div>
    </div>
  );
}
