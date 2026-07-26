import { useEffect, useMemo, useRef, useState } from 'react';

import { Activity, ListTree, Maximize2, RotateCcw, Sparkles, X } from 'lucide-react';

import type { BodyState } from '../physics/protocol/schemas';
import { CreationModeSwitcher, CreationPanel, useBodyCreation } from '../features/creation';
import { BodyEditingPanel, useBodyEditing } from '../features/editing';
import { BodyDirectory } from '../features/observatory/components/BodyDirectory';
import { BodyInspector } from '../features/observatory/components/BodyInspector';
import { CollisionEventPanel } from '../features/observatory/components/CollisionEventPanel';
import { ObservatoryHeader } from '../features/observatory/components/ObservatoryHeader';
import { TimeControls } from '../features/observatory/components/TimeControls';
import '../features/observatory/observatory.css';
import { UniverseViewport, type RendererBackend } from '../features/observatory/rendering';
import { formatSimulationTime, useUniverseSimulation } from '../features/observatory/simulation';

type MobilePanel = 'bodies' | 'collision' | 'details' | null;

export function App() {
  const simulation = useUniverseSimulation();
  const [backend, setBackend] = useState<RendererBackend | null>(null);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(null);
  const [renderError, setRenderError] = useState<Error | null>(null);
  const [selectedBodyId, setSelectedBodyId] = useState<string | null>('earth');
  const [focusedBodyId, setFocusedBodyId] = useState<string | null>(null);
  const [viewportKey, setViewportKey] = useState(0);
  const [collisionPanelDismissed, setCollisionPanelDismissed] = useState(false);
  const restoreDeleteActionFocusRef = useRef(false);
  const handledCollisionBatchSequenceRef = useRef(0);
  const creation = useBodyCreation({
    simulation,
    onCommitted: (bodyId) => {
      setSelectedBodyId(bodyId);
      setFocusedBodyId(bodyId);
      setMobilePanel(null);
    },
  });
  const editing = useBodyEditing({
    simulation,
    onEdited: ({ bodyId }) => {
      setSelectedBodyId(bodyId);
    },
    onDeleted: ({ deletedBodyId, fallbackBodyId }) => {
      setSelectedBodyId(fallbackBodyId);
      setFocusedBodyId((current) => (current === deletedBodyId ? fallbackBodyId : current));
    },
  });

  useEffect(() => {
    if (editing.operation === 'delete') {
      restoreDeleteActionFocusRef.current = true;
    }
    if (editing.active || simulation.commandPending || !restoreDeleteActionFocusRef.current) {
      return;
    }
    const deleteAction = document.querySelector<HTMLButtonElement>('[data-body-action="delete"]');
    if (deleteAction !== null && !deleteAction.disabled) {
      deleteAction.focus();
      restoreDeleteActionFocusRef.current = false;
    }
  }, [editing.active, editing.operation, simulation.commandPending]);

  const latestCollisionBatch = simulation.latestCollisionBatch;
  const simulationBodies = simulation.bodies;
  useEffect(() => {
    if (latestCollisionBatch === null) {
      handledCollisionBatchSequenceRef.current = 0;
      return;
    }
    if (latestCollisionBatch.collisionBatchSequence === handledCollisionBatchSequenceRef.current) {
      return;
    }
    handledCollisionBatchSequenceRef.current = latestCollisionBatch.collisionBatchSequence;
    setCollisionPanelDismissed(false);
    setMobilePanel('collision');

    const remnantIds = new Set(
      latestCollisionBatch.events.flatMap((event) => event.majorRemnantIds),
    );
    let largestRemnant: BodyState | null = null;
    for (const body of simulationBodies) {
      if (
        remnantIds.has(body.id) &&
        (largestRemnant === null || body.massKg > largestRemnant.massKg)
      ) {
        largestRemnant = body;
      }
    }
    if (largestRemnant !== null) {
      const remnantId = largestRemnant.id;
      setSelectedBodyId(remnantId);
      setFocusedBodyId((current) =>
        current !== null && !simulationBodies.some((body) => body.id === current)
          ? remnantId
          : current,
      );
    }
  }, [latestCollisionBatch, simulationBodies]);

  const effectiveSelectedBodyId = simulation.bodies.some((body) => body.id === selectedBodyId)
    ? selectedBodyId
    : (simulation.bodies[0]?.id ?? null);
  const effectiveFocusedBodyId = simulation.bodies.some((body) => body.id === focusedBodyId)
    ? focusedBodyId
    : null;

  const selectedBody = useMemo(
    () => simulation.bodies.find((body) => body.id === effectiveSelectedBodyId) ?? null,
    [effectiveSelectedBodyId, simulation.bodies],
  );
  const visibleError = renderError ?? (simulation.phase === 'error' ? simulation.error : null);
  const simulationTime = formatSimulationTime(simulation.simulationTimeSeconds);
  const viewMode = effectiveFocusedBodyId === null ? 'overview' : 'focus';

  const collisionPanelVisible =
    latestCollisionBatch !== null &&
    !collisionPanelDismissed &&
    !editing.active &&
    creation.mode === 'observe';

  const selectBody = (bodyId: string) => {
    if (editing.active) {
      return;
    }
    setSelectedBodyId(bodyId);
    setFocusedBodyId(bodyId);
    setMobilePanel('details');
  };

  const dismissCollisionPanel = () => {
    setCollisionPanelDismissed(true);
    setMobilePanel((current) => (current === 'collision' ? null : current));
  };

  const continueAfterCollision = () => {
    dismissCollisionPanel();
    void simulation.start().catch(() => undefined);
  };

  const showOverview = () => {
    setFocusedBodyId(null);
  };

  const retry = () => {
    setRenderError(null);
    setFocusedBodyId(null);
    setViewportKey((current) => current + 1);
    simulation.retry();
  };

  return (
    <main
      className="observatory-shell"
      data-phase={simulation.phase}
      data-mode={creation.mode}
      data-creation-phase={creation.mode === 'create' ? creation.phase : 'inactive'}
      data-editing-active={editing.active}
      data-editing-accepted-preview-revision={editing.acceptedPreviewRevision ?? 'none'}
      data-editing-candidate-revision={editing.candidateRevision}
      data-editing-operation={editing.operation ?? 'inactive'}
      data-editing-phase={editing.active ? editing.phase : 'inactive'}
      data-body-revision={simulation.bodyRevision}
      data-body-snapshot-time-seconds={simulation.bodySnapshotSimulationTimeSeconds}
      data-collision-batch-sequence={latestCollisionBatch?.collisionBatchSequence ?? 0}
      data-collision-event-count={latestCollisionBatch?.events.length ?? 0}
      data-collision-panel-open={collisionPanelVisible}
      data-simulation-time-seconds={simulation.simulationTimeSeconds}
      data-view-mode={viewMode}
      data-worker-state-sequence={simulation.latestStateSequence}
    >
      <UniverseViewport
        bodies={simulation.bodies}
        className="universe-viewport"
        creationState={creation.mode === 'create' ? creation.overlayState : editing.overlayState}
        dustCohorts={simulation.physicsState?.dustCohorts}
        focusBodyId={effectiveFocusedBodyId}
        key={viewportKey}
        onBackendChange={(nextBackend) => {
          setBackend(nextBackend);
        }}
        onError={(error) => {
          setRenderError(error);
          void simulation.pause().catch(() => undefined);
        }}
        onCreationPlacementChange={creation.updatePlacement}
        onSelectBody={selectBody}
        selectedBodyId={effectiveSelectedBodyId}
        simulationTimeSeconds={simulation.bodySnapshotSimulationTimeSeconds}
        tracers={simulation.physicsState?.tracers}
      />

      {viewMode === 'focus' ? (
        <button
          aria-label="返回太阳系全景"
          className="view-reset-button"
          onClick={showOverview}
          title="返回太阳系全景"
          type="button"
        >
          <Maximize2 aria-hidden="true" size={18} />
        </button>
      ) : null}

      <ObservatoryHeader
        backend={backend}
        runState={simulation.runState}
        simulationTime={simulationTime}
      />

      <CreationModeSwitcher
        disabled={editing.active || simulation.commandPending}
        mode={creation.mode}
        onModeChange={(mode) => {
          if (mode === 'create') {
            creation.enter();
          } else {
            creation.cancel();
          }
        }}
      />

      <aside
        aria-label="天体目录"
        className="observatory-panel body-directory-panel"
        data-mobile-open={mobilePanel === 'bodies'}
      >
        <button
          aria-label="关闭天体目录"
          className="mobile-panel-close"
          onClick={() => {
            setMobilePanel(null);
          }}
          title="关闭"
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
        <BodyDirectory
          bodies={simulation.bodies}
          disabled={editing.active}
          focusedBodyId={effectiveFocusedBodyId}
          onSelectBody={selectBody}
          selectedBodyId={effectiveSelectedBodyId}
        />
      </aside>

      {collisionPanelVisible ? (
        <aside
          aria-label="碰撞事件"
          className="observatory-panel collision-event-panel"
          data-mobile-open={mobilePanel === 'collision'}
        >
          <button
            aria-label="关闭碰撞事件"
            className="mobile-panel-close"
            onClick={() => {
              setMobilePanel(null);
            }}
            title="关闭"
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
          <CollisionEventPanel
            actionsDisabled={simulation.commandPending}
            batch={latestCollisionBatch}
            onContinue={continueAfterCollision}
            onDismiss={dismissCollisionPanel}
            onSelectBody={selectBody}
            physicsState={simulation.physicsState}
          />
        </aside>
      ) : null}

      {editing.active ? (
        <BodyEditingPanel controller={editing} />
      ) : creation.mode === 'observe' ? (
        <aside
          aria-label="天体数据"
          className="observatory-panel body-inspector-panel"
          data-mobile-open={mobilePanel === 'details'}
        >
          <button
            aria-label="关闭天体数据"
            className="mobile-panel-close"
            onClick={() => {
              setMobilePanel(null);
            }}
            title="关闭"
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
          <BodyInspector
            actionsDisabled={simulation.commandPending}
            baselineDiagnostics={simulation.baselineDiagnostics}
            body={selectedBody}
            bodies={simulation.bodies}
            diagnostics={simulation.diagnostics}
            onDeleteBody={editing.enterDelete}
            onEditBody={editing.enterEdit}
          />
        </aside>
      ) : (
        <CreationPanel
          draft={creation.draft}
          error={creation.error}
          onCancel={creation.cancel}
          onConfirm={creation.confirm}
          onPresetChange={creation.selectPreset}
          phase={creation.phase}
          presetId={creation.presetId}
          preview={creation.preview}
        />
      )}

      <nav aria-label="手机端数据面板" className="mobile-panel-tabs">
        <button
          aria-label="天体目录"
          aria-pressed={mobilePanel === 'bodies'}
          onClick={() => {
            setMobilePanel((current) => (current === 'bodies' ? null : 'bodies'));
          }}
          title="天体目录"
          type="button"
        >
          <ListTree aria-hidden="true" size={18} />
          <span>天体</span>
        </button>
        <button
          aria-label="天体数据"
          aria-pressed={mobilePanel === 'details'}
          onClick={() => {
            setMobilePanel((current) => (current === 'details' ? null : 'details'));
          }}
          title="天体数据"
          type="button"
        >
          <Activity aria-hidden="true" size={18} />
          <span>数据</span>
        </button>
        {collisionPanelVisible ? (
          <button
            aria-label="碰撞事件"
            aria-pressed={mobilePanel === 'collision'}
            onClick={() => {
              setMobilePanel((current) => (current === 'collision' ? null : 'collision'));
            }}
            title="碰撞事件"
            type="button"
          >
            <Sparkles aria-hidden="true" size={18} />
            <span>事件</span>
          </button>
        ) : null}
      </nav>

      <TimeControls
        commandPending={simulation.commandPending || creation.mode === 'create' || editing.active}
        onPause={() => {
          void simulation.pause().catch(() => undefined);
        }}
        onSetTimeScale={(timeScale) => {
          void simulation.setTimeScale(timeScale).catch(() => undefined);
        }}
        onStart={() => {
          void simulation.start().catch(() => undefined);
        }}
        onStep={(stepSeconds) => {
          void simulation.step(stepSeconds).catch(() => undefined);
        }}
        runState={simulation.runState}
        timeScale={simulation.timeScale}
      />

      {simulation.phase === 'initializing' ? (
        <div aria-live="polite" className="observatory-notice loading-notice">
          <span className="status-pulse" />
          正在连接物理核心
        </div>
      ) : null}

      {visibleError !== null ? (
        <section aria-live="assertive" className="observatory-notice error-notice">
          <div>
            <strong>模拟已安全暂停</strong>
            <p>{visibleError.message}</p>
          </div>
          <button onClick={retry} title="重新连接" type="button">
            <RotateCcw aria-hidden="true" size={17} />
            <span>重试</span>
          </button>
        </section>
      ) : null}
    </main>
  );
}
