'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useMe } from '@/components/app-shell';
import { Empty, fmtNumber, Icon, PageHeader } from '@/components/ui';

const STATUS: Record<string, [string, string]> = {
  active: ['Activo', 'badge-ok'],
  damaged: ['Dañado', 'badge-warn'],
  removed: ['Retirado', ''],
};
const today = () => new Date().toISOString().slice(0, 10);

export default function MedidoresPage() {
  const { me } = useMe();
  const [meters, setMeters] = useState<any[]>([]);
  const [subs, setSubs] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('active');
  const [form, setForm] = useState({ subscriberId: '', serial: '', brand: '', diameter: '1/2"', installedAt: today(), initialReading: '0' });
  const [error, setError] = useState('');
  const canEdit = me.role !== 'reader';
  const enabled = me.entitlements.features.meters !== false;

  const load = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([api<any[]>('/meters'), api<any[]>('/subscribers')]);
      setMeters(m);
      setSubs(s);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const withoutMeter = useMemo(() => {
    const has = new Set(meters.filter((m) => m.status === 'active').map((m) => m.subscriberId));
    return subs.filter((s) => !has.has(s.id));
  }, [meters, subs]);
  const shown = filter === 'all' ? meters : meters.filter((m) => m.status === filter);

  async function install(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/meters', {
        method: 'POST',
        body: JSON.stringify({
          ...form, brand: form.brand || undefined, diameter: form.diameter || undefined, initialReading: Number(form.initialReading || 0),
        }),
      });
      setForm({ ...form, subscriberId: '', serial: '', initialReading: '0' });
      setOpen(false);
      load();
    } catch (err: any) {
      setError(err.body?.issues?.[0]?.message ?? err.message);
    }
  }

  async function changeStatus(id: string, status: string) {
    const label = status === 'removed' ? 'retirar' : status === 'damaged' ? 'marcar como dañado' : 'reactivar';
    if (!confirm(`¿Seguro que quieres ${label} este medidor?`)) return;
    try {
      await api(`/meters/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, date: today() }) });
      load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <>
      <PageHeader
        title="Medidores"
        description={`${fmtNumber(meters.filter((m) => m.status === 'active').length)} activos · ${fmtNumber(withoutMeter.length)} suscriptores sin medidor`}
        actions={canEdit && enabled && <button className="btn" onClick={() => setOpen(!open)}><Icon name="plus" /> Instalar medidor</button>}
      />
      {!enabled && <div className="alert alert-warn">Tu plan no incluye el módulo de medidores.</div>}
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      {open && (
        <form className="card stack" onSubmit={install} style={{ marginBottom: 16 }}>
          <h2>Instalar medidor</h2>
          <div className="grid2">
            <label className="field">Suscriptor
              <select value={form.subscriberId} onChange={set('subscriberId')} required>
                <option value="">Selecciona…</option>
                {withoutMeter.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.fullName}</option>)}
              </select>
            </label>
            <label className="field">Serial<input value={form.serial} onChange={set('serial')} required /></label>
            <label className="field">Marca<input value={form.brand} onChange={set('brand')} /></label>
            <label className="field">Diámetro<input value={form.diameter} onChange={set('diameter')} /></label>
            <label className="field">Fecha de instalación<input type="date" value={form.installedAt} onChange={set('installedAt')} required /></label>
            <label className="field">Lectura inicial (m³)<input value={form.initialReading} onChange={set('initialReading')} inputMode="decimal" required /></label>
          </div>
          <div className="row">
            <button className="btn" type="submit">Instalar</button>
            <button className="btn btn-ghost" type="button" onClick={() => setOpen(false)}>Cancelar</button>
          </div>
        </form>
      )}

      <section className="card card-flush">
        <div className="card-head">
          <div className="tabs" role="tablist" style={{ border: 0 }}>
            {[['active', 'Activos'], ['damaged', 'Dañados'], ['removed', 'Retirados'], ['all', 'Todos']].map(([v, l]) => (
              <button key={v} role="tab" className="tab" aria-selected={filter === v} onClick={() => setFilter(v)}>{l}</button>
            ))}
          </div>
        </div>
        {shown.length === 0 ? (
          <Empty title="No hay medidores en esta vista" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Serial</th><th>Suscriptor</th><th>Instalado</th><th className="right">Lectura inicial</th><th>Estado</th>{canEdit && <th></th>}</tr></thead>
              <tbody>
                {shown.map((m) => {
                  const [label, cls] = STATUS[m.status] ?? [m.status, ''];
                  return (
                    <tr key={m.id}>
                      <td className="mono">{m.serial}{m.brand && <div className="small muted">{m.brand} {m.diameter}</div>}</td>
                      <td>{m.subscriber.code} · {m.subscriber.fullName}<div className="small muted">{m.subscriber.address}</div></td>
                      <td>{m.installedAt.slice(0, 10)}</td>
                      <td className="right mono">{fmtNumber(Number(m.initialReading), 2)}</td>
                      <td><span className={`badge ${cls}`}>{label}</span></td>
                      {canEdit && (
                        <td className="right">
                          {m.status === 'active' && (
                            <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                              <button className="btn btn-secondary btn-sm" onClick={() => changeStatus(m.id, 'damaged')}>Dañado</button>
                              <button className="btn btn-secondary btn-sm" onClick={() => changeStatus(m.id, 'removed')}>Retirar</button>
                            </span>
                          )}
                          {m.status === 'damaged' && <button className="btn btn-secondary btn-sm" onClick={() => changeStatus(m.id, 'active')}>Reactivar</button>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
