'use client';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
const TOKEN_KEY = 'aguamata.token';

// MVP: token en sessionStorage. Antes de producción pasar a cookie httpOnly emitida por el backend.
export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* almacenamiento no disponible */
  }
}

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
export async function apiUpload<T = any>(path: string, file: File, field = 'file'): Promise<T> {
  const fd = new FormData();
  fd.append(field, file);
  const token = getToken();
  const res = await fetch(`${API}${path}`, { method: 'POST', body: fd, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

/** Descarga un archivo autenticado y lo ofrece al usuario. */
export async function apiDownload(path: string, filename: string) {
  const token = getToken();
  const res = await fetch(`${API}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, null);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}
