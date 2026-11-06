'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { tenantDefaultUrl } from '@agua-mata/shared';
import { api, setToken } from '@/lib/api';
import { PLATFORM_ORIGIN, usePlatformOnly } from '@/lib/host';
import { Empty, fmtNumber, Icon, PageHeader, Stat } from '@/components/ui';

const ORG_STATUS: Record<string, [string, string]> = {
  onboarding: ['Configurando', 'badge-info'],
  active: ['Activo', 'badge-ok'],
  suspended: ['Suspendido', 'badge-danger'],
  deactivated: ['Desactivado', ''],
};

/** Panel Superadmin: solo metadatos y conteos. No muestra datos privados de ningún acueducto. */
export default function AdminPage() {
  const router = useRouter();
  const platformOk = usePlatformOnly();
  const [orgs, setOrgs] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setOrgs(await api('/platform/organizations'));
    } catch (e: any) {
      if (e.status === 401 || e.status === 403) router.push('/');
      else setError(e.message);
    }
  }, [router]);
  useEffect(() => { load(); }, [load]);

  async function setStatus(id: string, status: string) {
    const reason = prompt(`Motivo para cambiar el estado a "${status}" (queda en la auditoría):`);
    if (!reason) return;
    try {
      await api(`/platform/organizations/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, reason }) });
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? orgs.filter((o) => [o.name, o.nit, o.municipality, o.department, o.slug].some((v) => String(v).toLowerCase().includes(t))) : orgs;
  }, [orgs, q]);
  const totalSubs = orgs.reduce((a, o) => a + o.subscriberCount, 0);

  if (!platformOk) return null;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Icon name="drop" /></span><span className="brand-name">AguaMata<br /><span className="small muted">Superadmin</span></span></div>
        <a className="nav-link" href="/admin" aria-current="page"><Icon name="building" /> Organizaciones</a>
        <div className="sidebar-foot">
          <button className="nav-link" style={{ border: 0, background: 'none', cursor: 'pointer', font: 'inherit' }} onClick={() => { setToken(null); router.push('/'); }}>
            <Icon name="logout" /> Salir
          </button>
        </div>
      </aside>
      <div className="main">
        <div className="content">
          <PageHeader title="Organizaciones" description="Solo ves metadatos y conteos. Los datos de cada acueducto son privados." />
          {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}
          <div className="grid-stats" style={{ marginBottom: 16 }}>
            <Stat label="Acueductos" value={fmtNumber(orgs.length)} />
            <Stat label="Activos" value={fmtNumber(orgs.filter((o) => o.status === 'active').length)} />
            <Stat label="En prueba" value={fmtNumber(orgs.filter((o) => o.subscriptionStatus === 'trialing').length)} />
            <Stat label="Suscriptores atendidos" value={fmtNumber(totalSubs)} />
          </div>
          <section className="card card-flush">
            <div className="card-head">
              <input placeholder="Buscar por nombre, NIT o municipio" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 340 }} />
            </div>
            {filtered.length === 0 ? <Empty title="Sin organizaciones" /> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Acueducto</th><th>NIT</th><th>Ubicación</th><th>Plan</th><th className="right">Suscriptores</th><th>Estado</th><th></th></tr></thead>
                  <tbody>
                    {filtered.map((o) => {
                      const [label, cls] = ORG_STATUS[o.status] ?? [o.status, ''];
                      return (
                        <tr key={o.id}>
                          <td><strong>{o.name}</strong><div className="small"><a href={tenantDefaultUrl(PLATFORM_ORIGIN, o.slug)} target="_blank" rel="noreferrer">{o.slug}</a></div></td>
                          <td className="mono">{o.nit}</td>
                          <td>{o.municipality}, {o.department}</td>
                          <td>{o.plan?.name ?? '—'}<div className="small muted">{o.subscriptionStatus === 'trialing' ? 'Prueba' : o.subscriptionStatus ?? ''}{o.currentPeriodEnd ? ` · vence ${o.currentPeriodEnd.slice(0, 10)}` : ''}</div></td>
                          <td className="right mono">{fmtNumber(o.subscriberCount)}</td>
                          <td><span className={`badge ${cls}`}>{label}</span></td>
                          <td className="right">
                            {o.status === 'suspended'
                              ? <button className="btn btn-secondary btn-sm" onClick={() => setStatus(o.id, 'active')}>Reactivar</button>
                              : <button className="btn btn-secondary btn-sm" onClick={() => setStatus(o.id, 'suspended')}>Suspender</button>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
