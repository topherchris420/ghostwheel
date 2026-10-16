import type { Bootstrap } from './types';
let base = 'http://127.0.0.1:8765';
let token = '';
export async function discoverBackend() {
  if ('__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    const info = await invoke<{ base_url: string; token?: string }>('backend_info');
    base = info.base_url.replace(/\/$/, '');
    if (info.token) token = info.token;
  }
}
export async function request<T>(path: string, body?: unknown): Promise<T> {
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
