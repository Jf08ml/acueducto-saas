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
