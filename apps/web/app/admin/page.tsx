'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CYCLE_LABEL, SUBSCRIPTION_STATUS_LABEL, tenantDefaultUrl } from '@agua-mata/shared';
import { api } from '@/lib/api';
import { PLATFORM_ORIGIN } from '@/lib/host';
import { AdminShell } from '@/components/admin-shell';
import { Empty, errorText, fmtNumber, PageHeader, Stat } from '@/components/ui';
import { ConfirmModal, Modal } from '@/components/modal';

const ORG_STATUS: Record<string, [string, string]> = {
  onboarding: ['Configurando', 'badge-info'],
  active: ['Activo', 'badge-ok'],
  suspended: ['Suspendido', 'badge-danger'],
  deactivated: ['Desactivado', ''],
};
const SUB_BADGE: Record<string, string> = { trialing: 'badge-info', active: 'badge-ok', past_due: 'badge-warn', suspended: 'badge-danger' };
const date = (d?: string | null) => (d ? new Date(d).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', year: 'numeric' }) : '—');

/** Panel Superadmin: solo metadatos y conteos. No muestra datos privados de ningún acueducto. */
export default function AdminPage() {
  const router = useRouter();
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

  const [pending, setPending] = useState<{ org: any; status: string } | null>(null);
  const [subOrg, setSubOrg] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState('');

  async function confirmStatus(reason: string) {
    if (!pending) return;
    setBusy(true);
    setModalError('');
    try {
      await api(`/platform/organizations/${pending.org.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: pending.status, reason }) });
      setPending(null);
      load();
    } catch (e) {
      setModalError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const setStatus = (org: any, status: string) => { setModalError(''); setPending({ org, status }); };

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? orgs.filter((o) => [o.name, o.nit, o.municipality, o.department, o.slug].some((v) => String(v).toLowerCase().includes(t))) : orgs;
  }, [orgs, q]);
  const totalSubs = orgs.reduce((a, o) => a + o.subscriberCount, 0);

  return (
    <AdminShell>
      <PageHeader title="Organizaciones" description="Solo ves metadatos y conteos. Los datos de cada acueducto son privados." />
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}
      <div className="grid-stats" style={{ marginBottom: 16 }}>
        <Stat label="Acueductos" value={fmtNumber(orgs.length)} />
        <Stat label="Al día" value={fmtNumber(orgs.filter((o) => o.subscriptionStatus === 'active').length)} />
        <Stat label="En prueba" value={fmtNumber(orgs.filter((o) => o.subscriptionStatus === 'trialing').length)} />
        <Stat label="Pago pendiente o solo lectura" value={fmtNumber(orgs.filter((o) => o.subscriptionStatus === 'past_due' || o.subscriptionStatus === 'suspended').length)} />
        <Stat label="Suscriptores atendidos" value={fmtNumber(totalSubs)} />
      </div>
      <section className="card card-flush">
        <div className="card-head">
          <input placeholder="Buscar por nombre, NIT o municipio" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 340 }} />
        </div>
        {filtered.length === 0 ? <Empty title="Sin organizaciones" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Acueducto</th><th>NIT</th><th>Ubicación</th><th>Suscripción</th><th className="right">Suscriptores</th><th>Cuenta</th><th></th></tr></thead>
              <tbody>
                {filtered.map((o) => {
                  const [label, cls] = ORG_STATUS[o.status] ?? [o.status, ''];
                  return (
                    <tr key={o.id}>
                      <td><strong>{o.name}</strong><div className="small"><a href={tenantDefaultUrl(PLATFORM_ORIGIN, o.slug)} target="_blank" rel="noreferrer">{o.slug}</a></div></td>
                      <td className="mono">{o.nit}</td>
                      <td>{o.municipality}, {o.department}</td>
                      <td>
                        {o.subscriptionStatus ? <span className={`badge ${SUB_BADGE[o.subscriptionStatus] ?? ''}`}>{SUBSCRIPTION_STATUS_LABEL[o.subscriptionStatus] ?? o.subscriptionStatus}</span> : '—'}
                        <div className="small muted">{o.plan?.name ?? ''}{o.currentPeriodEnd ? ` · hasta ${date(o.currentPeriodEnd)}` : ''}</div>
                      </td>
                      <td className="right mono">{fmtNumber(o.subscriberCount)}</td>
                      <td><span className={`badge ${cls}`}>{label}</span></td>
                      <td className="right">
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => setSubOrg(o)}>Suscripción</button>
                          {o.status === 'suspended'
                            ? <button className="btn btn-secondary btn-sm" onClick={() => setStatus(o, 'active')}>Reactivar</button>
                            : <button className="btn btn-secondary btn-sm" onClick={() => setStatus(o, 'suspended')}>Suspender</button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <ConfirmModal
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={confirmStatus}
        busy={busy}
        error={modalError}
        danger={pending?.status === 'suspended'}
        title={pending?.status === 'suspended' ? 'Suspender acueducto' : 'Reactivar acueducto'}
        confirmLabel={pending?.status === 'suspended' ? 'Suspender' : 'Reactivar'}
        reasonLabel="Motivo (queda registrado en la auditoría)"
        message={pending && (pending.status === 'suspended'
          ? <p><strong>{pending.org.name}</strong> perderá todo el acceso hasta que se reactive (no es lo mismo que el modo de solo lectura por falta de pago). No se borra nada.</p>
          : <p><strong>{pending.org.name}</strong> recuperará el acceso a su cuenta.</p>)}
      />
      <SubscriptionModal org={subOrg} onClose={() => setSubOrg(null)} onSaved={() => { setSubOrg(null); load(); }} />
    </AdminShell>
  );
}

/** Ajuste manual: ciclo de cobro y fecha de corte (cortesía o activación). Mover la fecha al futuro reactiva la cuenta. */
function SubscriptionModal({ org, onClose, onSaved }: { org: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ billingCycle: 'monthly', currentPeriodEnd: '', reason: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (org) { setF({ billingCycle: org.billingCycle ?? 'monthly', currentPeriodEnd: '', reason: '' }); setError(''); }
  }, [org]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/platform/saas/organizations/${org.id}/subscription`, {
        method: 'PATCH',
        body: JSON.stringify({ billingCycle: f.billingCycle, reason: f.reason, ...(f.currentPeriodEnd ? { currentPeriodEnd: f.currentPeriodEnd } : {}) }),
      });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={org !== null} onClose={onClose} title={`Suscripción · ${org?.name ?? ''}`}
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancelar</button><button className="btn" type="submit" form="sub-form" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button></>}>
      {org && (
        <form id="sub-form" className="stack" onSubmit={submit}>
          <p className="muted small" style={{ margin: 0 }}>
            Estado: {SUBSCRIPTION_STATUS_LABEL[org.subscriptionStatus] ?? '—'} · Período hasta {date(org.currentPeriodEnd)}.
            Para registrar un pago usa <a href="/admin/cobros">Cobros</a>.
          </p>
          <label className="field">Ciclo de cobro
            <select value={f.billingCycle} onChange={(e) => setF({ ...f, billingCycle: e.target.value })}>
              {Object.entries(CYCLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="field">Nueva fecha de corte (opcional)
            <input type="date" value={f.currentPeriodEnd} onChange={(e) => setF({ ...f, currentPeriodEnd: e.target.value })} />
            <span className="small muted">Extiende el período sin cobrar (cortesía o activación manual). Si la cuenta estaba en solo lectura, se reactiva y la factura pendiente queda anulada.</span>
          </label>
          <label className="field">Motivo (queda en la auditoría)<textarea rows={2} required minLength={5} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
          {error && <div className="alert alert-danger">{error}</div>}
        </form>
      )}
    </Modal>
  );
}
