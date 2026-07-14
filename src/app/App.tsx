import { useMemo, useState } from 'react';

import { Activity, ListTree, Maximize2, RotateCcw, X } from 'lucide-react';

import { CreationModeSwitcher, CreationPanel, useBodyCreation } from '../features/creation';
import { BodyDirectory } from '../features/observatory/components/BodyDirectory';
import { BodyInspector } from '../features/observatory/components/BodyInspector';
import { ObservatoryHeader } from '../features/observatory/components/ObservatoryHeader';
import { TimeControls } from '../features/observatory/components/TimeControls';
import '../features/observatory/observatory.css';
import { UniverseViewport, type RendererBackend } from '../features/observatory/rendering';
import { formatSimulationTime, useUniverseSimulation } from '../features/observatory/simulation';

type MobilePanel = 'bodies' | 'details' | null;

export function App() {
  const simulation = useUniverseSimulation();
  const [backend, setBackend] = useState<RendererBackend | null>(null);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(null);
  const [renderError, setRenderError] = useState<Error | null>(null);
  const [selectedBodyId, setSelectedBodyId] = useState<string | null>('earth');
  const [focusedBodyId, setFocusedBodyId] = useState<string | null>(null);
  const [viewportKey, setViewportKey] = useState(0);
  const creation = useBodyCreation({
    simulation,
    onCommitted: (bodyId) => {
      setSelectedBodyId(bodyId);
      setFocusedBodyId(bodyId);
      setMobilePanel(null);
    },
  });

  const effectiveSelectedBodyId = simulation.bodies.some((body) => body.id === selectedBodyId)
    ? selectedBodyId
    : (simulation.bodies[0]?.id ?? null);

  const selectedBody = useMemo(
    () => simulation.bodies.find((body) => body.id === effectiveSelectedBodyId) ?? null,
    [effectiveSelectedBodyId, simulation.bodies],
  );
  const visibleError = renderError ?? (simulation.phase === 'error' ? simulation.error : null);
  const simulationTime = formatSimulationTime(simulation.simulationTimeSeconds);
  const viewMode = focusedBodyId === null ? 'overview' : 'focus';

  const selectBody = (bodyId: string) => {
    setSelectedBodyId(bodyId);
    setFocusedBodyId(bodyId);
    setMobilePanel('details');
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
      data-body-revision={simulation.bodyRevision}
      data-body-snapshot-time-seconds={simulation.bodySnapshotSimulationTimeSeconds}
      data-simulation-time-seconds={simulation.simulationTimeSeconds}
      data-view-mode={viewMode}
      data-worker-state-sequence={simulation.latestStateSequence}
    >
      <UniverseViewport
        bodies={simulation.bodies}
        className="universe-viewport"
        creationState={creation.overlayState}
        focusBodyId={focusedBodyId}
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
          focusedBodyId={focusedBodyId}
          onSelectBody={selectBody}
          selectedBodyId={effectiveSelectedBodyId}
        />
      </aside>

      {creation.mode === 'observe' ? (
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
            baselineDiagnostics={simulation.baselineDiagnostics}
            body={selectedBody}
            bodies={simulation.bodies}
            diagnostics={simulation.diagnostics}
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
      </nav>

      <TimeControls
        commandPending={simulation.commandPending || creation.mode === 'create'}
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
