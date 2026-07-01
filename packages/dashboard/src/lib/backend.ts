/**
 * Backend location for the live house. In prod set VITE_BACKEND_URL to the
 * Render service; in dev it defaults to localhost.
 */
export const BACKEND_URL: string =
  (import.meta.env.VITE_BACKEND_URL ?? '').trim() ||
  (import.meta.env.DEV ? 'http://localhost:4500' : '');

export function hasBackend(): boolean {
  return BACKEND_URL.length > 0;
}
