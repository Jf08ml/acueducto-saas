'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { USAGES } from '@agua-mata/shared';
import { api } from '@/lib/api';
import { useMe } from '@/components/app-shell';
import { Modal } from '@/components/modal';
import { Empty, errorText, fmtNumber, Icon, PageHeader } from '@/components/ui';

interface Form { code: string; fullName: string; documentNumber: string; address: string; stratum: string; usage: string; status: string }
const EMPTY: Form = { code: '', fullName: '', documentNumber: '', address: '', stratum: '', usage: 'residencial', status: 'active' };
const USAGE = Object.fromEntries(USAGES) as Record<string, string>;

export default function SuscriptoresPage() {
  const { me } = useMe();
  const [subs, setSubs] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [modal, setModal] = useState<{ mode: 'new' | 'edit'; id?: string } | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [busy, setBusy] = useState(false);
  const canEdit = me.role !== 'reader';

  const load = useCallback(() => api<any[]>('/subscribers').then(setSubs).catch((e) => setListError(errorText(e))), []);
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return subs;
    return subs.filter((s) => [s.code, s.fullName, s.documentNumber, s.address].some((v) => String(v).toLowerCase().includes(t)));
  }, [subs, q]);

  function openNew() {
    setForm(EMPTY);
    setError('');
    setModal({ mode: 'new' });
  }
  function openEdit(s: any) {
    setForm({ code: s.code, fullName: s.fullName, documentNumber: s.documentNumber, address: s.address, stratum: s.stratum ? String(s.stratum) : '', usage: s.usage ?? 'residencial', status: s.status });
    setError('');
    setModal({ mode: 'edit', id: s.id });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const common = { fullName: form.fullName, documentNumber: form.documentNumber, address: form.address, usage: form.usage };
    try {
      if (modal?.mode === 'new') {
        await api('/subscribers', { method: 'POST', body: JSON.stringify({ ...common, code: form.code, stratum: form.stratum ? Number(form.stratum) : undefined }) });
      } else {
        await api(`/subscribers/${modal!.id}`, { method: 'PATCH', body: JSON.stringify({ ...common, stratum: form.stratum ? Number(form.stratum) : null, status: form.status }) });
      }
      setModal(null);
      load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const max = me.entitlements.limits.max_subscribers;
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <>
      <PageHeader
        title="Suscriptores"
        description={`${fmtNumber(subs.length)}${max !== undefined && max !== -1 ? ` de ${fmtNumber(max)} permitidos por tu plan` : ''}`}
        actions={canEdit && (
          <>
            <a className="btn btn-secondary" href="/configuracion?paso=subscribers">Importar desde Excel</a>
            <button className="btn" onClick={openNew}><Icon name="plus" /> Nuevo suscriptor</button>
          </>
        )}
      />
      {listError && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{listError}</div>}

      <section className="card card-flush">
        <div className="card-head">
          <input placeholder="Buscar por código, nombre, documento o dirección" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 380 }} />
          <span className="muted small">{fmtNumber(filtered.length)} resultados</span>
        </div>
        {filtered.length === 0 ? (
          <Empty title={subs.length ? 'Sin resultados' : 'Aún no hay suscriptores'}>
            {!subs.length && canEdit && <button className="btn" onClick={openNew}>Agregar el primero</button>}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Código</th><th>Nombre</th><th>Documento</th><th>Dirección</th><th>Uso / estrato</th><th>Estado</th>{canEdit && <th></th>}</tr></thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.code}</td>
                    <td>{s.fullName}</td>
                    <td className="mono">{s.documentNumber}</td>
                    <td>{s.address}</td>
                    <td className="small">{s.usage === 'residencial' || !s.usage ? `Estrato ${s.stratum ?? '—'}` : USAGE[s.usage]}</td>
                    <td><span className={`badge ${s.status === 'active' ? 'badge-ok' : ''}`}>{s.status === 'active' ? 'Activo' : 'Inactivo'}</span></td>
                    {canEdit && (
                      <td className="right"><button className="icon-btn" onClick={() => openEdit(s)} aria-label={`Editar ${s.fullName}`} title="Editar"><Icon name="edit" /></button></td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal
        open={modal !== null}
        onClose={() => setModal(null)}
        title={modal?.mode === 'edit' ? `Editar suscriptor ${form.code}` : 'Nuevo suscriptor'}
        footer={<><button className="btn btn-secondary" onClick={() => setModal(null)}>Cancelar</button><button className="btn" type="submit" form="sub-form" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button></>}
      >
        <form id="sub-form" className="stack" onSubmit={save}>
          <div className="grid2">
            <label className="field">Código
              <input value={form.code} onChange={set('code')} required disabled={modal?.mode === 'edit'} autoFocus={modal?.mode === 'new'} />
              {modal?.mode === 'edit' && <span className="hint">El código no se cambia: es la referencia en lecturas y facturas.</span>}
            </label>
            <label className="field">Documento<input value={form.documentNumber} onChange={set('documentNumber')} required /></label>
          </div>
          <label className="field">Nombre completo<input value={form.fullName} onChange={set('fullName')} required autoFocus={modal?.mode === 'edit'} /></label>
          <label className="field">Dirección o ubicación<input value={form.address} onChange={set('address')} required /></label>
          <div className="grid2">
            <label className="field">Uso
              <select value={form.usage} onChange={set('usage')}>{USAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </label>
            <label className="field">Estrato
              <select value={form.stratum} onChange={set('stratum')}>
                <option value="">Sin estrato</option>
                {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
          {modal?.mode === 'edit' && (
            <label className="field">Estado
              <select value={form.status} onChange={set('status')}>
                <option value="active">Activo (se factura)</option>
                <option value="inactive">Inactivo (no se factura)</option>
              </select>
            </label>
          )}
          {modal?.mode === 'edit' && <p className="small muted">Las facturas ya emitidas conservan los datos con los que se expidieron.</p>}
          {error && <div className="alert alert-danger">{error}</div>}
        </form>
      </Modal>
    </>
  );
}
