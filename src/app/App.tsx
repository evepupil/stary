import { useMemo, useState } from 'react';

import { Activity, ListTree, RotateCcw, X } from 'lucide-react';

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
  const [viewportKey, setViewportKey] = useState(0);

  const effectiveSelectedBodyId = simulation.bodies.some((body) => body.id === selectedBodyId)
    ? selectedBodyId
    : (simulation.bodies[0]?.id ?? null);

  const selectedBody = useMemo(
    () => simulation.bodies.find((body) => body.id === effectiveSelectedBodyId) ?? null,
    [effectiveSelectedBodyId, simulation.bodies],
  );
  const visibleError = renderError ?? simulation.error;
  const simulationTime = formatSimulationTime(simulation.simulationTimeSeconds);

  const selectBody = (bodyId: string) => {
    setSelectedBodyId(bodyId);
    setMobilePanel('details');
  };

  const retry = () => {
    setRenderError(null);
    setViewportKey((current) => current + 1);
    simulation.retry();
  };

  return (
    <main
      className="observatory-shell"
      data-phase={simulation.phase}
      data-simulation-time-seconds={simulation.simulationTimeSeconds}
    >
      <UniverseViewport
        bodies={simulation.bodies}
        className="universe-viewport"
        key={viewportKey}
        onBackendChange={(nextBackend) => {
          setBackend(nextBackend);
        }}
        onError={(error) => {
          setRenderError(error);
          simulation.pause();
        }}
        onSelectBody={selectBody}
        selectedBodyId={effectiveSelectedBodyId}
      />

      <ObservatoryHeader
        backend={backend}
        runState={simulation.runState}
        simulationTime={simulationTime}
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
          onSelectBody={selectBody}
          selectedBodyId={effectiveSelectedBodyId}
        />
      </aside>

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
          diagnostics={simulation.diagnostics}
        />
      </aside>

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
        commandPending={simulation.commandPending}
        onPause={simulation.pause}
        onSetTimeScale={simulation.setTimeScale}
        onStart={simulation.start}
        onStep={simulation.step}
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
