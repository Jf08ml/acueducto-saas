'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '@/lib/api';

/** Panel Superadmin: solo metadatos y conteos. No muestra datos privados de ningún acueducto. */
export default function AdminPage() {
  const router = useRouter();
  const [orgs, setOrgs] = useState<any[]>([]);
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
    const reason = prompt(`Motivo para cambiar el estado a "${status}":`);
    if (!reason) return;
    try {
      await api(`/platform/organizations/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, reason }) });
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <>
      <header className="top">
        <strong>AguaMata · Superadmin</strong>
        <button className="secondary" onClick={() => { setToken(null); router.push('/'); }}>Salir</button>
      </header>
      <main className="container stack">
        <h2 style={{ margin: 0 }}>Organizaciones ({orgs.length})</h2>
        {error && <p className="error">{error}</p>}
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Acueducto</th><th>NIT</th><th>Ubicación</th><th>Plan</th><th>Suscripción</th><th>Suscriptores</th><th>Estado</th><th></th></tr>
            </thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.id}>
                  <td>{o.name}</td>
                  <td>{o.nit}</td>
                  <td>{o.municipality}, {o.department}</td>
                  <td>{o.plan?.name ?? '—'}</td>
                  <td><span className="badge">{o.subscriptionStatus ?? '—'}</span></td>
                  <td>{o.subscriberCount}</td>
                  <td><span className="badge">{o.status}</span></td>
                  <td>
                    {o.status === 'suspended'
                      ? <button className="secondary" onClick={() => setStatus(o.id, 'active')}>Reactivar</button>
                      : <button className="secondary" onClick={() => setStatus(o.id, 'suspended')}>Suspender</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
