'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useMe } from '@/components/app-shell';
import { Empty, fmtNumber, Icon, PageHeader } from '@/components/ui';

const EMPTY = { code: '', fullName: '', documentNumber: '', address: '', stratum: '' };

export default function SuscriptoresPage() {
  const { me } = useMe();
  const [subs, setSubs] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const canEdit = me.role !== 'reader';

  const load = useCallback(() => api<any[]>('/subscribers').then(setSubs).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return subs;
    return subs.filter((s) => [s.code, s.fullName, s.documentNumber, s.address].some((v) => String(v).toLowerCase().includes(t)));
  }, [subs, q]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/subscribers', {
        method: 'POST',
        body: JSON.stringify({ ...form, stratum: form.stratum ? Number(form.stratum) : undefined }),
      });
      setForm(EMPTY);
      setOpen(false);
      load();
    } catch (err: any) {
      setError(err.body?.issues?.[0]?.message ?? err.message);
    }
  }

  const max = me.entitlements.limits.max_subscribers;
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <>
      <PageHeader
        title="Suscriptores"
        description={`${fmtNumber(subs.length)}${max !== undefined && max !== -1 ? ` de ${fmtNumber(max)} permitidos por tu plan` : ''}`}
        actions={canEdit && (
          <>
            <a className="btn btn-secondary" href="/configuracion?paso=subscribers">Importar desde Excel</a>
            <button className="btn" onClick={() => setOpen(!open)}><Icon name="plus" /> Nuevo suscriptor</button>
          </>
        )}
      />

      {open && (
        <form className="card stack" onSubmit={add} style={{ marginBottom: 16 }}>
          <h2>Nuevo suscriptor</h2>
          <div className="grid2">
            <label className="field">Código<input value={form.code} onChange={set('code')} required /></label>
            <label className="field">Nombre completo<input value={form.fullName} onChange={set('fullName')} required /></label>
            <label className="field">Documento<input value={form.documentNumber} onChange={set('documentNumber')} required /></label>
            <label className="field">Dirección o ubicación<input value={form.address} onChange={set('address')} required /></label>
            <label className="field">Estrato
              <select value={form.stratum} onChange={set('stratum')}>
                <option value="">Sin estrato</option>
                {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
          {error && <div className="alert alert-danger">{error}</div>}
          <div className="row">
            <button className="btn" type="submit">Guardar</button>
            <button className="btn btn-ghost" type="button" onClick={() => setOpen(false)}>Cancelar</button>
          </div>
        </form>
      )}

      <section className="card card-flush">
        <div className="card-head">
          <input placeholder="Buscar por código, nombre, documento o dirección" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 380 }} />
          <span className="muted small">{fmtNumber(filtered.length)} resultados</span>
        </div>
        {filtered.length === 0 ? (
          <Empty title={subs.length ? 'Sin resultados' : 'Aún no hay suscriptores'}>
            {!subs.length && canEdit && <span>Agrégalos uno a uno o impórtalos desde Excel.</span>}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Código</th><th>Nombre</th><th>Documento</th><th>Dirección</th><th>Estrato</th><th>Estado</th></tr></thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.code}</td>
                    <td>{s.fullName}</td>
                    <td className="mono">{s.documentNumber}</td>
                    <td>{s.address}</td>
                    <td>{s.stratum ?? '—'}</td>
                    <td><span className={`badge ${s.status === 'active' ? 'badge-ok' : ''}`}>{s.status === 'active' ? 'Activo' : s.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
