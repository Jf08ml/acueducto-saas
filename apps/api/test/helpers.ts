import type { Response } from 'supertest';

/** Token de la sesión que la API puso en la cookie httpOnly (las pruebas lo envían como Bearer). */
export function sid(res: Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => x.startsWith('am_sid='));
  if (!c) throw new Error('La respuesta no abrió sesión (sin cookie am_sid)');
  return decodeURIComponent(c.slice('am_sid='.length).split(';')[0]);
}
