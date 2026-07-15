type ObservatorySceneModule = typeof import('./observatory-scene');

const OBSERVATORY_SCENE_CHUNK_PATH = /\/observatory-scene-[^/?#]+\.js$/u;
const URL_PATTERN = /https?:\/\/[^\s"'<>),]+/gu;
const RETRY_QUERY_PARAMETER = 'starySceneRetry';

let loadedModule: Promise<ObservatorySceneModule> | null = null;
let retryModuleUrl: URL | null = null;
let retryAttempt = 0;

export function extractObservatorySceneChunkUrl(error: unknown, allowedOrigin: string): URL | null {
  const description =
    error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  const expectedOrigin = new URL(allowedOrigin).origin;
  const candidates = description.match(URL_PATTERN) ?? [];

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.origin === expectedOrigin && OBSERVATORY_SCENE_CHUNK_PATH.test(url.pathname)) {
        return url;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function addObservatorySceneRetry(url: URL, attempt: number): string {
  const retryUrl = new URL(url.href);
  retryUrl.searchParams.set(RETRY_QUERY_PARAMETER, String(attempt));
  return retryUrl.href;
}

export function loadObservatoryScene(): Promise<ObservatorySceneModule> {
  if (loadedModule !== null) {
    return loadedModule;
  }

  const nextImport =
    retryModuleUrl === null
      ? import('./observatory-scene')
      : import(/* @vite-ignore */ addObservatorySceneRetry(retryModuleUrl, (retryAttempt += 1)));
  loadedModule = nextImport.catch((error: unknown) => {
    loadedModule = null;
    retryModuleUrl =
      extractObservatorySceneChunkUrl(error, window.location.origin) ?? retryModuleUrl;
    throw error;
  });
  return loadedModule;
}
