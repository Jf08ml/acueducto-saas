import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

export async function createApp() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000' });
  return app;
}

if (require.main === module) {
  createApp().then(async (app) => {
    const port = Number(process.env.API_PORT ?? 4000);
    await app.listen(port);
    console.log(`API escuchando en http://localhost:${port}/api/v1`);
  });
}
