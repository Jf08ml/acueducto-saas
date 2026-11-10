import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';

/**
 * Cifrado de secretos guardados en la BD (p. ej. la clave técnica de la DIAN) con AES-256-GCM.
 * La clave viene de APP_ENCRYPTION_KEY (32 bytes en base64: `openssl rand -base64 32`).
 * En producción es obligatoria; en desarrollo y pruebas se usa una clave fija (con aviso).
 * Formato guardado: v1:<iv>:<tag>:<datos>, todo en base64url.
 */
const DEV_KEY = createHash('sha256').update('aguamata-dev-only-key').digest();
let warned = false;

function key(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (raw) {
    const k = Buffer.from(raw, 'base64');
    if (k.length !== 32) throw new Error('APP_ENCRYPTION_KEY debe tener 32 bytes en base64 (openssl rand -base64 32)');
    return k;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('APP_ENCRYPTION_KEY es obligatoria en producción');
  if (!warned && process.env.NODE_ENV !== 'test') {
    warned = true;
    new Logger('Secrets').warn('APP_ENCRYPTION_KEY no está configurada: se usa una clave de desarrollo');
  }
  return DEV_KEY;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join(':');
}

export function decryptSecret(stored: string): string {
  const [v, iv, tag, data] = stored.split(':');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Secreto con formato desconocido');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
