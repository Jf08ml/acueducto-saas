/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Permite compilar en otra carpeta (p. ej. NEXT_DIST_DIR=.next-check) sin pisar la de `next dev`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
};
export default nextConfig;
