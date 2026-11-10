'use client';

/**
 * Cliente de la API. La sesión viaja en una cookie httpOnly que pone la API (el JavaScript de la página
 * no la puede leer). Las peticiones van al mismo origen (/api/v1) y Next.js las reenvía a la API.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';
/** La API exige este encabezado en toda petición que modifica datos (protección CSRF). */
const CSRF = { 'X-Requested-With': 'aguamata' };

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: any,
  ) {
    super(body?.message ?? `Error ${status}`);
  }
}

export const API_URL = API;

/** Sube un archivo (multipart). No fija Content-Type para que el navegador ponga el boundary. */
export async function apiUpload<T = any>(path: string, file: File, field = 'file', extra: Record<string, string> = {}): Promise<T> {
  const fd = new FormData();
  fd.append(field, file);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const res = await fetch(`${API}${path}`, { method: 'POST', body: fd, headers: CSRF, credentials: 'same-origin' });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

/** Descarga un archivo autenticado y lo ofrece al usuario. */
export async function apiDownload(path: string, filename: string) {
  const res = await fetch(`${API}${path}`, { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...CSRF, ...init.headers },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

/** Cierra la sesión en el servidor (revoca la cookie) y vuelve al inicio. */
export async function logout(to = '/') {
  await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
  window.location.href = to;
}

export interface JobStatus<R = any> {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  result: R | null;
  error: string | null;
}

/** Espera a que termine una tarea en segundo plano, informando el avance. Lanza ApiError si falla. */
export async function waitForJob<R = any>(id: string, onProgress?: (job: JobStatus<R>) => void, timeoutMs = 15 * 60_000, base = '/jobs'): Promise<R> {
  const started = Date.now();
  let delay = 400;
  for (;;) {
    const job = await api<JobStatus<R>>(`${base}/${id}`);
    onProgress?.(job);
    if (job.status === 'done') return job.result as R;
    if (job.status === 'failed') throw new ApiError(422, { message: job.error ?? 'La tarea falló' });
    if (Date.now() - started > timeoutMs) throw new ApiError(408, { message: 'La tarea está tardando más de lo normal. Revisa más tarde' });
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 3000);
  }
}

/** Abre en otra pestaña un archivo autenticado (p. ej. un comprobante), sin exponer la sesión en la URL. */
export async function apiOpen(path: string) {
  const tab = window.open('', '_blank');
  const res = await fetch(`${API}${path}`, { credentials: 'same-origin' });
  if (!res.ok) {
    tab?.close();
    throw new ApiError(res.status, await res.json().catch(() => null));
  }
  const url = URL.createObjectURL(await res.blob());
  if (tab) tab.location.href = url;
  else window.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
