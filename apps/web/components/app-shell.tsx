'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, API_URL, setToken } from '@/lib/api';
import { brandStyle, Icon } from './ui';

export interface Me {
  organization: {
    id: string; name: string; slug: string; municipality: string; department: string; status: string; onboardingCompletedAt: string | null;
    branding: { primaryColor?: string; secondaryColor?: string; receiptFooter?: string; hasLogo: boolean };
  };
  role: string;
  entitlements: { planCode: string | null; subscriptionStatus: string | null; features: Record<string, boolean>; limits: Record<string, number> };
}

const MeContext = createContext<{ me: Me; reload: () => Promise<void> } | null>(null);
export function useMe() {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error('useMe fuera de AppShell');
  return ctx;
}
export const isAdminRole = (role: string) => role === 'owner' || role === 'admin';

const NAV = [
  { href: '/panel', label: 'Inicio', icon: 'home' },
  { href: '/suscriptores', label: 'Suscriptores', icon: 'users' },
  { href: '/medidores', label: 'Medidores', icon: 'gauge' },
  { href: '/lecturas', label: 'Lecturas', icon: 'clipboard' },
  { href: '/facturacion', label: 'Facturación', icon: 'receipt' },
  { href: '/configuracion', label: 'Configuración', icon: 'settings', adminOnly: true },
];

const STATUS_LABEL: Record<string, string> = { trialing: 'Prueba', active: 'Activo', past_due: 'Pago pendiente', suspended: 'Suspendido' };

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      setMe(await api<Me>('/me/organization'));
    } catch (e: any) {
      if (e.status === 401 || e.status === 403) router.replace('/');
      else setError(e.message);
    }
  }, [router]);
  useEffect(() => { reload(); }, [reload]);

  if (!me) {
    return <div className="content">{error ? <div className="alert alert-danger">{error}</div> : <p className="muted">Cargando…</p>}</div>;
  }

  const b = me.organization.branding;
  const initials = me.organization.name.replace(/^acueducto\s+/i, '').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  return (
    <MeContext.Provider value={{ me, reload }}>
      <div className="shell" style={brandStyle(b.primaryColor)}>
        <aside className="sidebar">
          <div className="brand">
            {b.hasLogo
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={`${API_URL}/public/orgs/${me.organization.id}/logo`} alt="" />
              : <span className="brand-mark">{initials || 'A'}</span>}
            <span className="brand-name">{me.organization.name}</span>
          </div>
          {NAV.filter((n) => !n.adminOnly || isAdminRole(me.role)).map((n) => (
            <a key={n.href} href={n.href} className="nav-link" aria-current={pathname === n.href || pathname.startsWith(`${n.href}/`) ? 'page' : undefined}>
              <Icon name={n.icon} /> {n.label}
            </a>
          ))}
          <div className="sidebar-foot">
            <span className="small muted" style={{ padding: '0 10px' }}>
              Plan {me.entitlements.planCode ?? '—'} · {STATUS_LABEL[me.entitlements.subscriptionStatus ?? ''] ?? me.entitlements.subscriptionStatus ?? '—'}
            </span>
            <button className="nav-link btn-ghost" style={{ border: 0, background: 'none', cursor: 'pointer', font: 'inherit' }} onClick={() => { setToken(null); router.push('/'); }}>
              <Icon name="logout" /> Salir
            </button>
          </div>
        </aside>
        <div className="main">
          {!me.organization.onboardingCompletedAt && isAdminRole(me.role) && !pathname.startsWith('/configuracion') && (
            <div className="topbar">
              <span className="small">Completa la configuración inicial para empezar a facturar.</span>
              <a className="btn btn-sm" href="/configuracion">Continuar configuración</a>
            </div>
          )}
          <div className="content">{children}</div>
        </div>
      </div>
    </MeContext.Provider>
  );
}
