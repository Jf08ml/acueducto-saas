'use client';

import { useEffect, useState } from 'react';
import { classifyHost } from '@agua-mata/shared';
import { api } from './api';

export const PLATFORM_ORIGIN = process.env.NEXT_PUBLIC_PLATFORM_ORIGIN ?? 'http://localhost:3000';
export const PLATFORM_HOST = new URL(PLATFORM_ORIGIN).hostname;

export interface HostTenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  municipality: string;
  department: string;
  branding: { primaryColor?: string; secondaryColor?: string; hasLogo: boolean };
}

export type HostState =
  | { status: 'loading' }
  | { status: 'platform' }
  | { status: 'tenant'; tenant: HostTenant }
  | { status: 'not_found' };

/**
 * ¿Desde qué dirección se abrió la app? Plataforma (registro, superadmin) o la de un acueducto
 * (su subdominio por defecto o su dominio propio verificado).
 */
export function useHostTenant(): HostState {
  const [state, setState] = useState<HostState>({ status: 'loading' });
  useEffect(() => {
    const host = window.location.host;
    if (classifyHost(host, PLATFORM_HOST).kind === 'platform') {
      setState({ status: 'platform' });
      return;
    }
    api(`/public/resolve-host?host=${encodeURIComponent(host)}`)
      .then((r) => setState(r.organization ? { status: 'tenant', tenant: r.organization } : { status: 'platform' }))
      .catch(() => setState({ status: 'not_found' }));
  }, []);
  return state;
}

/**
 * Páginas que solo existen en el dominio de la plataforma (registro, superadmin). Si se abren desde la
 * dirección de un acueducto, se envía al usuario a la plataforma con la URL completa.
 * Se hace en el cliente porque Next.js convierte en relativas las redirecciones del middleware
 * cuando cambia solo el subdominio, lo que provocaría un ciclo.
 */
export function usePlatformOnly(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (classifyHost(window.location.host, PLATFORM_HOST).kind === 'platform') setOk(true);
    else window.location.replace(`${PLATFORM_ORIGIN}${window.location.pathname}${window.location.search}`);
  }, []);
  return ok;
}
