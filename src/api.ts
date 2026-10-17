import type { BrowserBackend } from './sim/backend';
import type { Bootstrap, Snapshot } from './types';
/**
 * Where the simulator runs: the desktop app's bundled loopback service, a Python
 * server started from source, or (on the hosted web build) inside this page.
 * VITE_SIMULATOR=browser|local overrides the default for web builds.
 */
export type Edition = 'desktop' | 'local' | 'browser';
const configured = import.meta.env.VITE_SIMULATOR;
export const edition: Edition =
  '__TAURI_INTERNALS__' in window
    ? 'desktop'
    : configured === 'browser' || configured === 'local'
      ? configured
      : import.meta.env.DEV
        ? 'local'
        : 'browser';
export const EDITION_NAME = {
  browser: 'Browser edition',
  desktop: 'Desktop edition',
  local: 'Developer build',
} as const;
let base = 'http://127.0.0.1:8765';
let token = '';
let browser: BrowserBackend | undefined;
let browserLoading: Promise<BrowserBackend> | undefined;
function browserBackend() {
  browserLoading ??= import('./sim/backend').then(
    ({ BrowserBackend }) => {
      browser = new BrowserBackend();
      browser.start();
      return browser;
    },
    (error: unknown) => {
      browserLoading = undefined; // let the next connection attempt retry the download
      throw error;
    },
  );
  return browserLoading;
}
export async function discoverBackend() {
  if (edition === 'desktop') {
    const { invoke } = await import('@tauri-apps/api/core');
    const info = await invoke<{ base_url: string; token?: string }>('backend_info');
    base = info.base_url.replace(/\/$/, '');
    if (info.token) token = info.token;
  }
}
export async function request<T>(path: string, body?: unknown): Promise<T> {
  if (edition === 'browser') return (await browserBackend()).request<T>(path, body);
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Ghostwheel-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error || value.detail || `Backend returned ${response.status}`);
  return value as T;
}
export async function bootstrap() {
  const value = await request<Bootstrap>('/api/bootstrap');
  token = value.token;
  return value;
}
export function setToken(value: string) {
  token = value;
}
// Live state is pushed over a WebSocket. Browsers cannot attach X-Ghostwheel-Token to the
// handshake, so the token is the first message; the server closes with 1008 otherwise.
// The browser edition subscribes to the in-page simulator instead.
export function openStream(
  onSnapshot: (state: Snapshot) => void,
  onClose: () => void,
): { close: () => void } {
  if (edition === 'browser') {
    if (!browser) {
      const retry = setTimeout(onClose, 0);
      return { close: () => clearTimeout(retry) };
    }
    return { close: browser.subscribe((state) => onSnapshot(state as unknown as Snapshot)) };
  }
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/api/stream`);
  socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token }));
  socket.onmessage = (event: MessageEvent<string>) => {
    const message = JSON.parse(event.data) as { type: string; snapshot?: Snapshot };
    if (message.type === 'snapshot' && message.snapshot) onSnapshot(message.snapshot);
  };
  socket.onclose = onClose;
  return socket;
}
