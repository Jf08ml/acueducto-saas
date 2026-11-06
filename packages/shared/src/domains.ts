/**
 * Reglas de dominios. Cada acueducto tiene siempre un subdominio de la plataforma ({slug}.{raíz})
 * y puede agregar dominios propios verificados por DNS.
 */

/** Subdominios que nunca pueden ser el slug de un acueducto. */
export const RESERVED_SLUGS = new Set([
  'www', 'app', 'api', 'admin', 'superadmin', 'panel', 'static', 'assets', 'cdn', 'mail', 'smtp', 'ftp',
  'soporte', 'support', 'ayuda', 'help', 'docs', 'blog', 'status', 'billing', 'pagos', 'tenants', 'registro',
]);

const HOSTNAME_RE = /^(?=.{4,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;

export function normalizeHostname(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
}

export function isValidHostname(hostname: string): boolean {
  return HOSTNAME_RE.test(hostname);
}

/** Nombre del registro TXT que el acueducto debe crear para probar que el dominio es suyo. */
export const DOMAIN_VERIFICATION_PREFIX = '_aguamata-verify';

export type HostKind =
  | { kind: 'platform' }
  | { kind: 'subdomain'; slug: string }
  | { kind: 'custom'; hostname: string };

/**
 * Clasifica un host entrante. rootHost es el host de la plataforma sin puerto (p. ej. "aguamata.co" o "localhost").
 */
export function classifyHost(host: string, rootHost: string): HostKind {
  const h = normalizeHostname(host);
  const root = normalizeHostname(rootHost);
  if (h === root || h === `www.${root}`) return { kind: 'platform' };
  if (h.endsWith(`.${root}`)) {
    const sub = h.slice(0, -(root.length + 1));
    if (!sub.includes('.') && !RESERVED_SLUGS.has(sub)) return { kind: 'subdomain', slug: sub };
    return { kind: 'platform' };
  }
  return { kind: 'custom', hostname: h };
}

/** URL por defecto del acueducto, a partir del origen de la plataforma (p. ej. http://localhost:3000). */
export function tenantDefaultUrl(platformOrigin: string, slug: string): string {
  const u = new URL(platformOrigin);
  return `${u.protocol}//${slug}.${u.host}`;
}
