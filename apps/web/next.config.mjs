import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Las tres variables quedan FIJAS al compilar (next build): NEXT_PUBLIC_* se incrustan en el JavaScript del navegador
// y los rewrites se resuelven en la compilación. Si cambian, hay que volver a compilar.
const API_INTERNAL_URL = process.env.API_INTERNAL_URL || 'http://localhost:4000';
const PLATFORM_ORIGIN = process.env.NEXT_PUBLIC_PLATFORM_ORIGIN;

// En una compilación de producción, sin la dirección de la plataforma los subdominios y enlaces apuntarían a localhost.
if (process.env.NODE_ENV === 'production' && !process.env.NEXT_DIST_DIR) {
  const problems = [];
  if (!PLATFORM_ORIGIN) problems.push('NEXT_PUBLIC_PLATFORM_ORIGIN no está definida (p. ej. https://aguamata.co)');
  if (!process.env.API_INTERNAL_URL) problems.push('API_INTERNAL_URL no está definida (dirección interna de la API, p. ej. http://api:4000)');
  if (problems.length) throw new Error(`Configuración de la web incompleta:\n - ${problems.join('\n - ')}`);
  if (/localhost|127\.0\.0\.1/.test(PLATFORM_ORIGIN)) console.warn(`Aviso: NEXT_PUBLIC_PLATFORM_ORIGIN apunta a ${PLATFORM_ORIGIN}`);
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Permite compilar en otra carpeta (p. ej. NEXT_DIST_DIR=.next-check) sin pisar la de `next dev`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Imagen de Docker liviana: next build genera .next/standalone con lo justo para correr.
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  // Monorepo: el rastreo de archivos parte de la raíz para incluir @agua-mata/shared en la imagen.
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  // La web reenvía /api/v1 a la API: el navegador habla con un solo origen, así la cookie de sesión
  // (httpOnly) queda en la dirección del acueducto, sea subdominio o dominio propio.
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API_INTERNAL_URL}/api/v1/:path*` }];
  },
};
export default nextConfig;
