import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contexto por petición. El middleware crea el objeto vacío; el TenantGuard fija organizationId
 * solo después de verificar la membresía. Todo el acceso a datos de tenant lee de aquí.
 */
export interface RequestContext {
  userId?: string;
  organizationId?: string;
  role?: string;
  isPlatformAdmin?: boolean;
  /** Si el acceso viene de una sesión de soporte aprobada. */
  supportGrantId?: string;
  ip?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext {
  return requestContext.getStore() ?? {};
}

/** Ejecuta fn con un tenant fijado (para jobs en segundo plano, seeds y tests). */
export function runAsTenant<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ organizationId }, fn);
}
