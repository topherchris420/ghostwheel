/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "browser" runs the simulator in the page; "local" uses a Python server on 127.0.0.1:8765. */
  readonly VITE_SIMULATOR?: 'browser' | 'local';
  /** Optional help desk or contact URL shown as "Get support" in About. */
  readonly VITE_SUPPORT_URL?: string;
}

/** package.json version, injected by vite.config.ts. */
declare const __APP_VERSION__: string;
