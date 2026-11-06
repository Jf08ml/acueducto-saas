'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useMe } from '@/components/app-shell';
import { Modal } from '@/components/modal';
import { Empty, errorText, fmtNumber, Icon, PageHeader } from '@/components/ui';

const STATUS: Record<string, [string, string]> = {
  active: ['Activo', 'badge-ok'],
  damaged: ['Dañado', 'badge-warn'],
  removed: ['Retirado', ''],
};
const ACTION: Record<string, { title: string; label: string; help: string }> = {
  damaged: { title: 'Marcar medidor como dañado', label: 'Marcar dañado', help: 'No se podrán registrar lecturas hasta reactivarlo. Mientras tanto registra la causal en Lecturas.' },
  removed: { title: 'Retirar medidor', label: 'Retirar', help: 'El suscriptor quedará sin medidor activo y podrás instalarle uno nuevo.' },
  active: { title: 'Reactivar medidor', label: 'Reactivar', help: 'El medidor volverá a aparecer en la planilla de lecturas.' },
};
const today = () => new Date().toISOString().slice(0, 10);
const EMPTY = { subscriberId: '', serial: '', brand: '', diameter: '1/2"', installedAt: today(), initialReading: '0' };

export default function MedidoresPage() {
  const { me } = useMe();
  const [meters, setMeters] = useState<any[]>([]);
  const [subs, setSubs] = useState<any[]>([]);
  const [filter, setFilter] = useState('active');
  const [installOpen, setInstallOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [statusModal, setStatusModal] = useState<{ meter: any; status: string } | null>(null);
  const [statusForm, setStatusForm] = useState({ date: today(), notes: '' });
  const [error, setError] = useState('');
  const [modalError, setModalError] = useState('');
  const [busy, setBusy] = useState(false);
  const canEdit = me.role !== 'reader';
  const enabled = me.entitlements.features.meters !== false;

  const load = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([api<any[]>('/meters'), api<any[]>('/subscribers')]);
      setMeters(m);
      setSubs(s);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const withoutMeter = useMemo(() => {
    const has = new Set(meters.filter((m) => m.status === 'active').map((m) => m.subscriberId));
    return subs.filter((s) => s.status === 'active' && !has.has(s.id));
  }, [meters, subs]);
  const shown = filter === 'all' ? meters : meters.filter((m) => m.status === filter);

  async function run(action: () => Promise<unknown>, close: () => void) {
    setModalError('');
    setBusy(true);
    try {
      await action();
      close();
      load();
    } catch (err) {
      setModalError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function install(e: React.FormEvent) {
    e.preventDefault();
    run(() => api('/meters', {
      method: 'POST',
      body: JSON.stringify({ ...form, brand: form.brand || undefined, diameter: form.diameter || undefined, initialReading: Number(form.initialReading.replace(',', '.') || 0) }),
    }), () => { setInstallOpen(false); setForm(EMPTY); });
  }

  function changeStatus(e: React.FormEvent) {
    e.preventDefault();
    const { meter, status } = statusModal!;
    run(() => api(`/meters/${meter.id}/status`, { method: 'PATCH', body: JSON.stringify({ status, date: statusForm.date, notes: statusForm.notes || undefined }) }), () => setStatusModal(null));
  }

  const openStatus = (meter: any, status: string) => { setModalError(''); setStatusForm({ date: today(), notes: '' }); setStatusModal({ meter, status }); };
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const action = statusModal ? ACTION[statusModal.status] : null;

  return (
    <>
      <PageHeader
        title="Medidores"
        description={`${fmtNumber(meters.filter((m) => m.status === 'active').length)} activos · ${fmtNumber(withoutMeter.length)} suscriptores sin medidor`}
        actions={canEdit && enabled && <button className="btn" onClick={() => { setModalError(''); setInstallOpen(true); }}><Icon name="plus" /> Instalar medidor</button>}
      />
      {!enabled && <div className="alert alert-warn">Tu plan no incluye el módulo de medidores.</div>}
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

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
                      <td>{m.installedAt.slice(0, 10)}{m.removedAt && <div className="small muted">Retirado {m.removedAt.slice(0, 10)}</div>}</td>
                      <td className="right mono">{fmtNumber(Number(m.initialReading), 2)}</td>
                      <td><span className={`badge ${cls}`}>{label}</span>{m.notes && <div className="small muted">{m.notes}</div>}</td>
                      {canEdit && (
                        <td className="right">
                          <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                            {m.status === 'active' && <>
                              <button className="btn btn-secondary btn-sm" onClick={() => openStatus(m, 'damaged')}>Dañado</button>
                              <button className="btn btn-secondary btn-sm" onClick={() => openStatus(m, 'removed')}>Retirar</button>
                            </>}
                            {m.status === 'damaged' && <>
                              <button className="btn btn-secondary btn-sm" onClick={() => openStatus(m, 'active')}>Reactivar</button>
                              <button className="btn btn-secondary btn-sm" onClick={() => openStatus(m, 'removed')}>Retirar</button>
                            </>}
                          </span>
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

      <Modal
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        title="Instalar medidor"
        footer={<><button className="btn btn-secondary" onClick={() => setInstallOpen(false)}>Cancelar</button><button className="btn" type="submit" form="install-form" disabled={busy}>{busy ? 'Guardando…' : 'Instalar'}</button></>}
      >
        <form id="install-form" className="stack" onSubmit={install}>
          <label className="field">Suscriptor
            <select value={form.subscriberId} onChange={set('subscriberId')} required autoFocus>
              <option value="">Selecciona…</option>
              {withoutMeter.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.fullName}</option>)}
            </select>
            {withoutMeter.length === 0 && <span className="hint">Todos los suscriptores activos ya tienen medidor.</span>}
          </label>
          <div className="grid2">
            <label className="field">Serial<input value={form.serial} onChange={set('serial')} required /></label>
            <label className="field">Marca<input value={form.brand} onChange={set('brand')} /></label>
            <label className="field">Diámetro<input value={form.diameter} onChange={set('diameter')} /></label>
            <label className="field">Fecha de instalación<input type="date" value={form.installedAt} onChange={set('installedAt')} required /></label>
          </div>
          <label className="field">Lectura inicial (m³)
            <span className="hint">La que marca el medidor al instalarlo. La primera lectura se calcula desde este valor.</span>
            <input value={form.initialReading} onChange={set('initialReading')} inputMode="decimal" required />
          </label>
          {modalError && <div className="alert alert-danger">{modalError}</div>}
        </form>
      </Modal>

      <Modal
        open={statusModal !== null}
        onClose={() => setStatusModal(null)}
        title={action?.title ?? ''}
        footer={<><button className="btn btn-secondary" onClick={() => setStatusModal(null)}>Cancelar</button><button className={`btn ${statusModal?.status === 'removed' ? 'btn-danger' : ''}`} type="submit" form="status-form" disabled={busy}>{action?.label}</button></>}
      >
        {statusModal && (
          <form id="status-form" className="stack" onSubmit={changeStatus}>
            <p>Medidor <strong className="mono">{statusModal.meter.serial}</strong> de {statusModal.meter.subscriber.code} · {statusModal.meter.subscriber.fullName}.</p>
            <p className="muted small">{action?.help}</p>
            <label className="field">Fecha<input type="date" value={statusForm.date} onChange={(e) => setStatusForm({ ...statusForm, date: e.target.value })} required /></label>
            <label className="field">Nota (opcional)<textarea rows={2} value={statusForm.notes} onChange={(e) => setStatusForm({ ...statusForm, notes: e.target.value })} maxLength={500} /></label>
            {modalError && <div className="alert alert-danger">{modalError}</div>}
          </form>
        )}
      </Modal>
    </>
  );
}
