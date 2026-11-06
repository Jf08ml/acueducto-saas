'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, API_URL, setToken } from '@/lib/api';

interface Me {
  organization: {
    id: string; name: string; municipality: string; department: string; status: string; onboardingCompletedAt: string | null;
    branding: { primaryColor?: string; hasLogo: boolean };
  };
  role: string;
  entitlements: { planCode: string | null; subscriptionStatus: string | null; limits: Record<string, number> };
}

export default function PanelPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [subs, setSubs] = useState<any[]>([]);
  const [form, setForm] = useState({ code: '', fullName: '', documentNumber: '', address: '' });
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([api<Me>('/me/organization'), api<any[]>('/subscribers')]);
      setMe(m);
      setSubs(s);
    } catch (e: any) {
      if (e.status === 401) router.push('/');
      else setError(e.message);
    }
  }, [router]);

  useEffect(() => { load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/subscribers', { method: 'POST', body: JSON.stringify(form) });
      setForm({ code: '', fullName: '', documentNumber: '', address: '' });
      load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  const max = me?.entitlements.limits.max_subscribers;

  return (
    <>
      <header className="top" style={me?.organization.branding.primaryColor ? { borderBottom: `4px solid ${me.organization.branding.primaryColor}` } : undefined}>
        <span className="row">
          {me?.organization.branding.hasLogo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`${API_URL}/public/orgs/${me.organization.id}/logo`} alt="" style={{ height: 32 }} />
          )}
          <strong>{me?.organization.name ?? 'AguaMata'}</strong>
        </span>
        <span className="row">
          {me && ['owner', 'admin'].includes(me.role) && <a href="/configuracion">Configuración</a>}
          <button className="secondary" onClick={() => { setToken(null); router.push('/'); }}>Salir</button>
        </span>
      </header>
      <main className="container stack">
        {me && !me.organization.onboardingCompletedAt && ['owner', 'admin'].includes(me.role) && (
          <div className="card row" style={{ justifyContent: 'space-between' }}>
            <span>Tu acueducto aún no termina la configuración inicial (perfil regulatorio, tarifa, marca).</span>
            <a href="/configuracion">Continuar configuración</a>
          </div>
        )}
        {me && (
          <p className="muted" style={{ margin: 0 }}>
            {me.organization.municipality}, {me.organization.department} · Plan <span className="badge">{me.entitlements.planCode}</span>{' '}
            <span className="badge">{me.entitlements.subscriptionStatus}</span> · Rol: {me.role}
          </p>
        )}
        <section className="card stack">
          <h2 style={{ margin: 0 }}>Suscriptores <span className="muted">({subs.length}{max !== undefined && max !== -1 ? ` de ${max}` : ''})</span></h2>
          <form className="row" onSubmit={add}>
            <input placeholder="Código" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required />
            <input placeholder="Nombre completo" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} required />
            <input placeholder="Documento" value={form.documentNumber} onChange={(e) => setForm({ ...form, documentNumber: e.target.value })} required />
            <input placeholder="Dirección" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} required />
            <button type="submit">Agregar</button>
          </form>
          {error && <p className="error">{error}</p>}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Código</th><th>Nombre</th><th>Documento</th><th>Dirección</th><th>Estado</th></tr></thead>
              <tbody>
                {subs.map((s) => (
                  <tr key={s.id}><td>{s.code}</td><td>{s.fullName}</td><td>{s.documentNumber}</td><td>{s.address}</td><td>{s.status}</td></tr>
                ))}
                {subs.length === 0 && <tr><td colSpan={5} className="muted">Aún no hay suscriptores.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </>
  );
}
