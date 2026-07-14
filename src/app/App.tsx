import type { ProbeState } from '../platform/probes/probe-state';
import { useFoundationProbes } from './use-foundation-probes';

interface ProbeRowProps {
  readonly label: string;
  readonly probe: 'renderer' | 'wasm' | 'worker';
  readonly state: ProbeState;
}

function ProbeRow({ label, probe, state }: ProbeRowProps) {
  return (
    <div>
      <dt>{label}</dt>
      <dd aria-live="polite" data-probe={probe} data-status={state.status}>
        {state.status === 'loading' ? '检查中' : state.status === 'ready' ? '就绪' : '错误'}：
        {state.message}
      </dd>
    </div>
  );
}

export function App() {
  const probes = useFoundationProbes();

  return (
    <main className="foundation-shell">
      <section aria-labelledby="foundation-title" className="foundation-status">
        <p className="product-name">STARY</p>
        <h1 id="foundation-title">宇宙模拟工程底座</h1>
        <dl>
          <ProbeRow label="渲染模块路径 / 运行时探针" probe="renderer" state={probes.renderer} />
          <ProbeRow label="正式物理 Worker / 完整生命周期" probe="worker" state={probes.worker} />
          <ProbeRow label="WASM 资源路径 / 运行时探针" probe="wasm" state={probes.wasm} />
        </dl>
      </section>
    </main>
  );
}
