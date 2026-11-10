import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainsService } from './domains/domains.module';

export async function createApp() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  // La web reenvía /api/v1 a esta API (mismo origen para la cookie de sesión): confiar en X-Forwarded-* del proxy.
  app.getHttpAdapter().getInstance().set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
  // CORS dinámico: la web puede servirse desde el dominio de la plataforma, el subdominio de cada
  // acueducto o un dominio propio verificado.
  const domains = app.get(DomainsService);
  app.enableCors({
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      domains.isAllowedOrigin(origin).then((ok) => cb(null, ok), () => cb(null, false));
    },
  });
  return app;
}

if (require.main === module) {
  createApp().then(async (app) => {
    const port = Number(process.env.API_PORT ?? 4000);
    await app.listen(port);
    console.log(`API escuchando en http://localhost:${port}/api/v1`);
  });
}
