'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, API_URL, logout } from '@/lib/api';
import { ROLE_LABEL } from '@agua-mata/shared';
import { brandStyle, errorText, Icon } from './ui';
import { Modal } from './modal';

export interface Me {
  organization: {
    id: string; name: string; slug: string; municipality: string; department: string; status: string; onboardingCompletedAt: string | null;
    branding: { primaryColor?: string; secondaryColor?: string; receiptFooter?: string; hasLogo: boolean };
  };
  role: string;
  user: { id: string; email: string; fullName: string };
  membershipId: string | null;
  /** Presente si es una sesión de soporte de AguaMata (aprobada por el acueducto). */
  support: { id: string; scope: 'read' | 'write'; expiresAt: string } | null;
  entitlements: { planCode: string | null; subscriptionStatus: string | null; features: Record<string, boolean>; limits: Record<string, number> };
  subscription: { status: string; trialEndsAt: string | null; currentPeriodEnd: string; graceEndsAt: string | null } | null;
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
  { href: '/recaudo', label: 'Recaudo', icon: 'cash' },
  { href: '/cartera', label: 'Cartera', icon: 'chart' },
  { href: '/usuarios', label: 'Usuarios', icon: 'shield', adminOnly: true },
  { href: '/suscripcion', label: 'Suscripción', icon: 'drop', adminOnly: true },
  { href: '/auditoria', label: 'Auditoría', icon: 'clipboard', adminOnly: true },
  { href: '/configuracion', label: 'Configuración', icon: 'settings', adminOnly: true },
];

function PasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setF({ currentPassword: '', newPassword: '', confirm: '' }); setError(''); setOk(false); } }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (f.newPassword !== f.confirm) { setError('Las contraseñas nuevas no coinciden'); return; }
    setBusy(true);
    setError('');
    try {
      await api('/auth/password', { method: 'PATCH', body: JSON.stringify({ currentPassword: f.currentPassword, newPassword: f.newPassword }) });
      setOk(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Cambiar contraseña"
      footer={ok ? <button className="btn" onClick={onClose}>Listo</button> : <><button className="btn btn-secondary" onClick={onClose}>Cancelar</button><button className="btn" type="submit" form="pw-form" disabled={busy}>Cambiar</button></>}>
      {ok ? <div className="alert alert-ok">Contraseña actualizada. Cerramos tus sesiones abiertas en otros equipos.</div> : (
        <form id="pw-form" className="stack" onSubmit={submit}>
          <label className="field">Contraseña actual<input type="password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} required autoFocus /></label>
          <label className="field">Nueva contraseña (mínimo 8)<input type="password" autoComplete="new-password" minLength={8} value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} required /></label>
          <label className="field">Repite la nueva<input type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required /></label>
          {error && <div className="alert alert-danger">{error}</div>}
        </form>
      )}
    </Modal>
  );
}

const STATUS_LABEL: Record<string, string> = { trialing: 'Prueba', active: 'Al día', past_due: 'Pago pendiente', suspended: 'Solo lectura' };
const shortDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long' }) : '');

/** Aviso de la suscripción arriba de todas las páginas: prueba por terminar, pago pendiente o solo lectura. */
function SubscriptionBanner({ me, pathname }: { me: Me; pathname: string }) {
  const s = me.subscription;
  if (!s || pathname.startsWith('/suscripcion')) return null;
  const admin = isAdminRole(me.role);
  const cta = admin ? <a className="btn btn-sm" href="/suscripcion">{s.status === 'trialing' ? 'Ver suscripción' : 'Pagar ahora'}</a> : null;
  const daysLeft = Math.ceil((new Date(s.currentPeriodEnd).getTime() - Date.now()) / 86_400_000);
  let text: string | null = null;
  let tone = 'topbar';
  if (s.status === 'suspended') {
    text = admin
      ? 'La cuenta está en modo de solo lectura por falta de pago: puedes consultar, pero no registrar cambios.'
      : 'La cuenta está en modo de solo lectura por falta de pago. Pídele a un administrador que pague la suscripción.';
    tone = 'topbar topbar-danger';
  } else if (s.status === 'past_due') {
    text = `La factura de AguaMata está vencida. Paga antes del ${shortDate(s.graceEndsAt)} para no perder la edición.`;
    tone = 'topbar topbar-warn';
  } else if (s.status === 'trialing' && daysLeft <= 7 && admin) {
    text = daysLeft > 0 ? `Tu prueba termina en ${daysLeft} día${daysLeft === 1 ? '' : 's'} (${shortDate(s.currentPeriodEnd)}).` : 'Tu prueba terminó.';
  }
  if (!text) return null;
  return <div className={tone} role="status"><span className="small">{text}</span>{cta}</div>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');
  const [orgs, setOrgs] = useState<{ id: string; name: string; role: string }[]>([]);
  const [pwOpen, setPwOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      setMe(await api<Me>('/me/organization'));
    } catch (e: any) {
      if (e.status === 401 || e.status === 403) router.replace('/');
      else setError(e.message);
    }
  }, [router]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { api('/auth/organizations').then(setOrgs).catch(() => setOrgs([])); }, []);

  async function switchOrg(organizationId: string) {
    try {
      await api('/auth/switch', { method: 'POST', body: JSON.stringify({ organizationId }) });
      window.location.href = '/panel';
    } catch (e: any) {
      setError(errorText(e));
    }
  }

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
            {orgs.length > 1 && !me.support && (
              <label className="field" style={{ padding: '0 10px' }}>
                <span className="small muted">Acueducto</span>
                <select value={me.organization.id} onChange={(e) => switchOrg(e.target.value)} aria-label="Cambiar de acueducto">
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </label>
            )}
            <div style={{ padding: '0 10px' }}>
              <div className="small" style={{ fontWeight: 600 }}>{me.user.fullName}</div>
              <div className="small muted">{ROLE_LABEL[me.role] ?? me.role} · Plan {me.entitlements.planCode ?? '—'} ({STATUS_LABEL[me.entitlements.subscriptionStatus ?? ''] ?? me.entitlements.subscriptionStatus ?? '—'})</div>
            </div>
            {!me.support && (
              <button className="nav-link" style={{ border: 0, background: 'none', cursor: 'pointer', font: 'inherit' }} onClick={() => setPwOpen(true)}>
                <Icon name="shield" /> Cambiar contraseña
              </button>
            )}
            <button className="nav-link" style={{ border: 0, background: 'none', cursor: 'pointer', font: 'inherit' }} onClick={() => logout()}>
              <Icon name="logout" /> Salir
            </button>
          </div>
        </aside>
        <div className="main">
          {me.support && (
            <div className="topbar topbar-support" role="status">
              <span className="small">
                <strong>Sesión de soporte de AguaMata</strong> en {me.organization.name} · {me.support.scope === 'read' ? 'solo consulta' : 'puede modificar'} ·
                vence {new Date(me.support.expiresAt).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit' })}. Todo queda en la auditoría del acueducto.
              </span>
              <button className="btn btn-sm" onClick={() => logout('/')}>Salir del soporte</button>
            </div>
          )}
          <SubscriptionBanner me={me} pathname={pathname} />
          {!me.organization.onboardingCompletedAt && isAdminRole(me.role) && !pathname.startsWith('/configuracion') && (
            <div className="topbar">
              <span className="small">Completa la configuración inicial para empezar a facturar.</span>
              <a className="btn btn-sm" href="/configuracion">Continuar configuración</a>
            </div>
          )}
          <div className="content">{children}</div>
        </div>
      </div>
      <PasswordModal open={pwOpen} onClose={() => setPwOpen(false)} />
    </MeContext.Provider>
  );
}
