import { checkEnv } from '../src/config/env-check';

const GOOD = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://aguamata_app:Str0ng-App-Pass@db:5432/aguamata',
  DIRECT_DATABASE_URL: 'postgresql://aguamata_owner:Str0ng-Owner-Pass@db:5432/aguamata',
  REDIS_URL: 'redis://redis:6379',
  PLATFORM_WEB_ORIGIN: 'https://aguamata.co',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  MAIL_PROVIDER: 'ses',
  MAIL_FROM: 'AguaMata <no-responder@aguamata.co>',
  STORAGE_DRIVER: 's3',
  S3_BUCKET: 'aguamata-archivos',
  MP_ACCESS_TOKEN: 'APP_USR-123',
  MP_WEBHOOK_SECRET: 'secreto',
  API_PUBLIC_URL: 'https://api.aguamata.co',
  COOKIE_SECURE: 'true',
  TRUST_PROXY: 'uniquelocal',
} as NodeJS.ProcessEnv;

describe('Revisión de variables de entorno', () => {
  it('una configuración de producción completa no tiene errores ni avisos', () => {
    expect(checkEnv(GOOD)).toEqual({ errors: [], warnings: [] });
  });

  it('la API nunca puede usar el rol dueño (RLS no aplicaría)', () => {
    const r = checkEnv({ ...GOOD, DATABASE_URL: GOOD.DIRECT_DATABASE_URL });
    expect(r.errors.join()).toMatch(/rol sin privilegios/);
  });

  it('detecta lo que en producción haría fallar a medias', () => {
    const r = checkEnv({
      ...GOOD, PLATFORM_WEB_ORIGIN: 'http://localhost:3000', APP_ENCRYPTION_KEY: undefined, MAIL_PROVIDER: 'log', REDIS_URL: undefined,
      DATABASE_URL: 'postgresql://aguamata_app:app_dev_pw@db:5432/aguamata', MP_WEBHOOK_SECRET: undefined,
    });
    const all = r.errors.join(' | ');
    for (const k of ['localhost', 'https', 'APP_ENCRYPTION_KEY', 'MAIL_PROVIDER', 'REDIS_URL', 'contraseña de desarrollo', 'MP_WEBHOOK_SECRET']) expect(all).toContain(k);
  });

  it('fuera de producción lo mismo solo son avisos', () => {
    const r = checkEnv({ ...GOOD, NODE_ENV: 'development', PLATFORM_WEB_ORIGIN: 'http://localhost:3000', MAIL_PROVIDER: 'log', APP_ENCRYPTION_KEY: undefined });
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('avisa (sin bloquear) por almacenamiento local, Mercado Pago de pruebas y proxy sin definir', () => {
    const r = checkEnv({ ...GOOD, STORAGE_DRIVER: 'local', MP_ACCESS_TOKEN: 'TEST-1', TRUST_PROXY: undefined, COOKIE_SECURE: undefined });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(4);
  });
});
