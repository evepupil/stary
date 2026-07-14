/// <reference types="vite/client" />

declare module '*spikes/rebound-wasm/dist/rebound.mjs' {
  const createReboundModule: import('./physics/rebound/emscripten-types').ReboundModuleFactory;
  export default createReboundModule;
}
