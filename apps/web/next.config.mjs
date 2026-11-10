/** @type {import('next').NextConfig} */
const API_INTERNAL_URL = process.env.API_INTERNAL_URL || 'http://localhost:4000';

const nextConfig = {
  reactStrictMode: true,
  // Permite compilar en otra carpeta (p. ej. NEXT_DIST_DIR=.next-check) sin pisar la de `next dev`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // La web reenvía /api/v1 a la API: el navegador habla con un solo origen, así la cookie de sesión
  // (httpOnly) queda en la dirección del acueducto, sea subdominio o dominio propio.
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API_INTERNAL_URL}/api/v1/:path*` }];
  },
};
export default nextConfig;
