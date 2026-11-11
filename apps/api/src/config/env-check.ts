import { Logger } from '@nestjs/common';

/**
 * Revisión de variables de entorno al arrancar. En producción, si falta algo crítico la API NO arranca y dice
 * exactamente qué falta (mejor que funcionar a medias: enlaces a localhost, correos que no salen, secretos sin cifrar).
 * Fuera de producción solo avisa.
 */
export interface EnvReport {
  errors: string[];
  warnings: string[];
}

const DEV_PASSWORDS = ['app_dev_pw', 'owner_dev_pw'];

function parseUrl(v: string | undefined): URL | null {
  try {
    return v ? new URL(v) : null;
  } catch {
    return null;
  }
}

const isLocal = (u: URL) => ['localhost', '127.0.0.1', '0.0.0.0'].includes(u.hostname) || u.hostname.endsWith('.localhost');

export function checkEnv(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prod = env.NODE_ENV === 'production';
  const need = (cond: boolean, msg: string) => { if (!cond) (prod ? errors : warnings).push(msg); };

  // Base de datos: la API SIEMPRE con el rol sin privilegios, si no RLS no protege nada.
  const db = parseUrl(env.DATABASE_URL);
  const owner = parseUrl(env.DIRECT_DATABASE_URL);
  if (!db) errors.push('DATABASE_URL no está configurada o no es una URL válida');
  else {
    if (owner && db.username === owner.username) errors.push('DATABASE_URL usa el mismo rol que DIRECT_DATABASE_URL: la API debe conectarse con el rol sin privilegios (aguamata_app) para que RLS aísle a los acueductos');
    if (['postgres', 'aguamata_owner'].includes(db.username)) errors.push(`DATABASE_URL usa el rol "${db.username}": la API debe usar el rol de la aplicación (sin BYPASSRLS)`);
    need(!DEV_PASSWORDS.includes(decodeURIComponent(db.password)), 'DATABASE_URL usa la contraseña de desarrollo');
  }
  if (owner) need(!DEV_PASSWORDS.includes(decodeURIComponent(owner.password)), 'DIRECT_DATABASE_URL usa la contraseña de desarrollo');

  // Dirección pública de la plataforma (enlaces de correo, subdominios, CORS, retorno de Mercado Pago).
  const origin = parseUrl(env.PLATFORM_WEB_ORIGIN);
  need(Boolean(origin), 'PLATFORM_WEB_ORIGIN no está configurada (p. ej. https://aguamata.co)');
  if (origin) {
    need(!isLocal(origin), `PLATFORM_WEB_ORIGIN apunta a ${origin.hostname}: los enlaces de los correos no funcionarán`);
    need(origin.protocol === 'https:', 'PLATFORM_WEB_ORIGIN debe usar https');
  }

  // Cola de tareas: sin Redis no hay revisión diaria del cobro ni tareas en segundo plano.
  if (env.QUEUE_DRIVER === 'inline') need(false, 'QUEUE_DRIVER=inline: sin cola no corren la revisión diaria del cobro ni los reintentos');
  else need(Boolean(parseUrl(env.REDIS_URL)), 'REDIS_URL no está configurada');

  // Secretos cifrados (clave técnica de la DIAN).
  const key = env.APP_ENCRYPTION_KEY ? Buffer.from(env.APP_ENCRYPTION_KEY, 'base64') : null;
  need(key?.length === 32, 'APP_ENCRYPTION_KEY falta o no tiene 32 bytes en base64 (openssl rand -base64 32)');

  // Correo: sin proveedor no llegan invitaciones, recuperación de contraseña ni avisos de cobro.
  const mail = (env.MAIL_PROVIDER ?? 'log').toLowerCase();
  need(mail !== 'log', 'MAIL_PROVIDER=log: no se envía ningún correo (invitaciones, recuperar contraseña, facturas de la plataforma). Usa ses o smtp');
  if (mail === 'smtp') need(Boolean(env.SMTP_URL || env.SMTP_HOST), 'MAIL_PROVIDER=smtp requiere SMTP_URL o SMTP_HOST');
  if (mail !== 'log') need(Boolean(env.MAIL_FROM) && !/tu-dominio|aguamata\.local/.test(env.MAIL_FROM ?? ''), 'MAIL_FROM no está configurado con un remitente real y verificado');

  // Archivos.
  const storage = (env.STORAGE_DRIVER ?? 'local').toLowerCase();
  if (storage === 's3') need(Boolean(env.S3_BUCKET), 'STORAGE_DRIVER=s3 requiere S3_BUCKET');
  else if (prod) warnings.push('STORAGE_DRIVER=local: los archivos quedan en el disco del servidor. Usa un volumen persistente con copia de respaldo, o S3');

  // Mercado Pago (opcional): si se configura, debe poder recibir el webhook.
  if (env.MP_ACCESS_TOKEN) {
    const api = parseUrl(env.API_PUBLIC_URL);
    need(Boolean(api) && api!.protocol === 'https:' && !isLocal(api!), 'Con Mercado Pago, API_PUBLIC_URL debe ser la URL https pública de la API (para el webhook)');
    need(Boolean(env.MP_WEBHOOK_SECRET), 'Con Mercado Pago, MP_WEBHOOK_SECRET es obligatoria (verifica la firma del webhook)');
    if (prod && env.MP_ACCESS_TOKEN.startsWith('TEST-')) warnings.push('MP_ACCESS_TOKEN es de pruebas (TEST-): los pagos no son reales');
  } else if (prod) {
    warnings.push('Mercado Pago no está configurado: los acueductos solo podrán pagar por transferencia');
  }

  if (prod && !env.COOKIE_SECURE) warnings.push('COOKIE_SECURE no está definida: la cookie solo será Secure si el proxy envía X-Forwarded-Proto: https. Recomendado: COOKIE_SECURE=true');
  if (prod && !env.TRUST_PROXY) warnings.push('TRUST_PROXY no está definida (por defecto loopback): si el proxy o la web corren en otro contenedor, defínela (p. ej. "uniquelocal") para registrar la IP real');

  return { errors, warnings };
}

/** Revisa y, en producción, detiene el arranque si hay errores. */
export function assertEnv() {
  if (process.env.NODE_ENV === 'test') return;
  const log = new Logger('Config');
  const { errors, warnings } = checkEnv();
  for (const w of warnings) log.warn(w);
  if (errors.length) {
    const msg = `Configuración inválida:\n - ${errors.join('\n - ')}`;
    if (process.env.NODE_ENV === 'production') throw new Error(msg);
    for (const e of errors) log.error(e);
  }
}
