'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CYCLE_LABEL, SAAS_INVOICE_STATUS_LABEL, SAAS_PAYMENT_METHOD_LABEL, type SaasSettings } from '@agua-mata/shared';
import { api, apiOpen, waitForJob } from '@/lib/api';
import { AdminShell } from '@/components/admin-shell';
import { ConfirmModal, Modal } from '@/components/modal';
import { Empty, errorText, fmtMoney, fmtNumber, Icon, PageHeader, Stat } from '@/components/ui';

const date = (d?: string | null) => (d ? new Date(d).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const INVOICE_BADGE: Record<string, string> = { pending: 'badge-warn', in_review: 'badge-info', paid: 'badge-ok', void: '' };

interface Overview {
  plan: { id: string; name: string; priceMonthlyCop: number; priceYearlyCop: number; trialDays: number };
  settings: SaasSettings;
  mercadoPagoEnabled: boolean;
  subscriptionCounts: Record<string, number>;
  pendingTransfers: any[];
  invoices: any[];
}

/** Cobro del SaaS: plan, medios de pago, transferencias por aprobar y facturas de todos los acueductos. */
export default function CobrosPage() {
  const router = useRouter();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [planOpen, setPlanOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rejecting, setRejecting] = useState<any>(null);
  const [voiding, setVoiding] = useState<any>(null);
  const [manual, setManual] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState('');
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<Overview>('/platform/saas'));
    } catch (e: any) {
      if (e.status === 401 || e.status === 403) router.push('/');
      else setError(errorText(e));
    }
  }, [router]);
  useEffect(() => { load(); }, [load]);

  async function act(fn: () => Promise<unknown>, done: string, close: () => void) {
    setBusy(true);
    setModalError('');
    try {
      await fn();
      close();
      setNotice(done);
      await load();
    } catch (e) {
      setModalError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function approve(p: any) {
    setNotice('');
    try {
      await api(`/platform/saas/payments/${p.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
      setNotice(`Transferencia de ${p.organization.name} aprobada. La suscripción quedó al día.`);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function runDaily() {
    setRunning(true);
    setNotice('');
    try {
      const job = await api<{ id: string }>('/platform/saas/run-daily', { method: 'POST' });
      const r = await pollPlatformJob(job.id);
      setNotice(r ? `Revisión lista: ${r.checked} suscripciones, ${r.invoiced} facturas nuevas, ${r.pastDue} con pago pendiente, ${r.suspended} en solo lectura.` : 'Revisión encolada.');
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRunning(false);
    }
  }

  const invoices = useMemo(() => (data?.invoices ?? []).filter((i) => filter === 'all' || i.status === 'pending' || i.status === 'in_review'), [data, filter]);

  return (
    <AdminShell>
      <PageHeader
        title="Cobros"
        description="Cobro de la plataforma a cada acueducto. La revisión diaria corre a las 6:00 a. m. (hora de Colombia)."
        actions={<button className="btn btn-secondary" onClick={runDaily} disabled={running}>{running ? 'Revisando…' : 'Ejecutar revisión ahora'}</button>}
      />
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}
      {notice && <div className="alert alert-ok" style={{ marginBottom: 16 }} role="status">{notice}</div>}
      {!data ? <p className="muted">Cargando…</p> : (
        <div className="stack">
          <div className="grid-stats">
            <Stat label="En prueba" value={fmtNumber(data.subscriptionCounts.trialing ?? 0)} />
            <Stat label="Al día" value={fmtNumber(data.subscriptionCounts.active ?? 0)} />
            <Stat label="Pago pendiente" value={fmtNumber(data.subscriptionCounts.past_due ?? 0)} />
            <Stat label="Solo lectura" value={fmtNumber(data.subscriptionCounts.suspended ?? 0)} />
          </div>

          <div className="grid2">
            <section className="card stack-sm">
              <div className="row-between"><h2 style={{ margin: 0 }}>Plan</h2><button className="btn btn-secondary btn-sm" onClick={() => { setModalError(''); setPlanOpen(true); }}><Icon name="edit" /> Editar</button></div>
              <strong>{data.plan.name}</strong>
              <span>{fmtMoney(data.plan.priceMonthlyCop)} al mes · {fmtMoney(data.plan.priceYearlyCop)} al año</span>
              <span className="small muted">{data.plan.trialDays} días de prueba · todos los módulos, sin límites</span>
              <span className="small muted">Un cambio de precio aplica a las facturas que se emitan desde ahora.</span>
            </section>
            <section className="card stack-sm">
              <div className="row-between"><h2 style={{ margin: 0 }}>Medios de pago y plazos</h2><button className="btn btn-secondary btn-sm" onClick={() => { setModalError(''); setSettingsOpen(true); }}><Icon name="edit" /> Editar</button></div>
              <span>Mercado Pago: {data.mercadoPagoEnabled ? <span className="badge badge-ok">Configurado</span> : <span className="badge">Sin configurar (MP_ACCESS_TOKEN)</span>}</span>
              <span>Transferencia: {data.settings.bank.accountNumber
                ? <>{data.settings.bank.bankName} · {data.settings.bank.accountType} <span className="mono">{data.settings.bank.accountNumber}</span></>
                : <span className="badge badge-warn">Falta la cuenta</span>}</span>
              <span className="small muted">La factura sale {data.settings.invoiceLeadDays} días antes del corte · {data.settings.graceDays} días de gracia antes de pasar a solo lectura</span>
            </section>
          </div>

          <section className="card card-flush">
            <div className="card-head"><h2 style={{ margin: 0 }}>Transferencias por revisar</h2></div>
            {data.pendingTransfers.length === 0 ? <Empty title="No hay transferencias pendientes" /> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Acueducto</th><th>Factura</th><th className="right">Valor</th><th>Referencia</th><th>Fecha</th><th></th></tr></thead>
                  <tbody>
                    {data.pendingTransfers.map((p) => (
                      <tr key={p.id}>
                        <td><strong>{p.organization.name}</strong><div className="small muted">NIT {p.organization.nit}-{p.organization.nitDv}</div></td>
                        <td className="mono">N.º {p.invoice.number}</td>
                        <td className="right mono">{fmtMoney(p.amountCop)}</td>
                        <td className="mono">{p.reference}{p.notes && <div className="small muted">{p.notes}</div>}</td>
                        <td>{date(p.paidAt)}</td>
                        <td className="right">
                          <div className="row" style={{ justifyContent: 'flex-end' }}>
                            {p.hasProof && <button className="btn btn-ghost btn-sm" onClick={() => apiOpen(`/platform/saas/payments/${p.id}/proof`).catch((e) => setError(errorText(e)))}>Ver comprobante</button>}
                            <button className="btn btn-secondary btn-sm" onClick={() => { setModalError(''); setRejecting(p); }}>Rechazar</button>
                            <button className="btn btn-sm" onClick={() => approve(p)}>Aprobar</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card card-flush">
            <div className="card-head">
              <h2 style={{ margin: 0 }}>Facturas</h2>
              <div className="row">
                <label className="radio-inline"><input type="radio" checked={filter === 'open'} onChange={() => setFilter('open')} /> Por cobrar</label>
                <label className="radio-inline"><input type="radio" checked={filter === 'all'} onChange={() => setFilter('all')} /> Todas</label>
              </div>
            </div>
            {invoices.length === 0 ? <Empty title={filter === 'open' ? 'No hay facturas por cobrar' : 'Aún no hay facturas'} /> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>N.º</th><th>Acueducto</th><th>Período</th><th className="right">Valor</th><th>Vence</th><th>Estado</th><th></th></tr></thead>
                  <tbody>
                    {invoices.map((i) => (
                      <tr key={i.id}>
                        <td className="mono">{i.number}</td>
                        <td>{i.organization.name}</td>
                        <td className="small">{date(i.periodStart)} – {date(i.periodEnd)}<div className="muted">{CYCLE_LABEL[i.billingCycle as 'monthly']}</div></td>
                        <td className="right mono">{fmtMoney(i.amountCop)}</td>
                        <td>{date(i.dueDate)}</td>
                        <td>
                          <span className={`badge ${INVOICE_BADGE[i.status] ?? ''}`}>{SAAS_INVOICE_STATUS_LABEL[i.status] ?? i.status}</span>
                          {i.paidAt && <div className="small muted">{date(i.paidAt)} · {SAAS_PAYMENT_METHOD_LABEL[i.paymentMethod] ?? i.paymentMethod}</div>}
                          {i.voidReason && <div className="small muted">{i.voidReason}</div>}
                        </td>
                        <td className="right">
                          {(i.status === 'pending' || i.status === 'in_review') && (
                            <div className="row" style={{ justifyContent: 'flex-end' }}>
                              <button className="btn btn-ghost btn-sm" onClick={() => { setModalError(''); setVoiding(i); }}>Anular</button>
                              <button className="btn btn-secondary btn-sm" onClick={() => { setModalError(''); setManual(i); }}>Registrar pago</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {data && <PlanModal open={planOpen} plan={data.plan} onClose={() => setPlanOpen(false)} onSaved={() => { setPlanOpen(false); setNotice('Plan actualizado.'); load(); }} />}
      {data && <SettingsModal open={settingsOpen} settings={data.settings} onClose={() => setSettingsOpen(false)} onSaved={() => { setSettingsOpen(false); setNotice('Configuración guardada.'); load(); }} />}
      <ManualPaymentModal invoice={manual} onClose={() => setManual(null)} onSaved={() => { setManual(null); setNotice('Pago registrado. La suscripción quedó al día.'); load(); }} />
      <ConfirmModal
        open={rejecting !== null} onClose={() => setRejecting(null)} busy={busy} error={modalError} danger
        title="Rechazar transferencia" confirmLabel="Rechazar" reasonLabel="Motivo (se le envía al acueducto)"
        message={rejecting && <p>La factura N.º {rejecting.invoice.number} de <strong>{rejecting.organization.name}</strong> vuelve a quedar por pagar.</p>}
        onConfirm={(reason) => act(() => api(`/platform/saas/payments/${rejecting.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'reject', reason }) }), 'Transferencia rechazada. Le avisamos al acueducto.', () => setRejecting(null))}
      />
      <ConfirmModal
        open={voiding !== null} onClose={() => setVoiding(null)} busy={busy} error={modalError} danger
        title="Anular factura" confirmLabel="Anular" reasonLabel="Motivo (queda en la auditoría)"
        message={voiding && <p>Se anula la factura N.º {voiding.number} de <strong>{voiding.organization.name}</strong>. La revisión diaria emitirá una nueva si corresponde.</p>}
        onConfirm={(reason) => act(() => api(`/platform/saas/invoices/${voiding.id}/void`, { method: 'POST', body: JSON.stringify({ reason }) }), 'Factura anulada.', () => setVoiding(null))}
      />
    </AdminShell>
  );
}

/** Las tareas de plataforma no tienen acueducto: se siguen por /platform/jobs. */
async function pollPlatformJob(id: string | null): Promise<any> {
  if (!id) return null;
  try {
    return await waitForJob(id, undefined, 60_000, '/platform/jobs');
  } catch {
    return null;
  }
}

function PlanModal({ open, plan, onClose, onSaved }: { open: boolean; plan: Overview['plan']; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: '', priceMonthlyCop: '', priceYearlyCop: '', trialDays: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setF({ name: plan.name, priceMonthlyCop: String(plan.priceMonthlyCop), priceYearlyCop: String(plan.priceYearlyCop), trialDays: String(plan.trialDays) }); setError(''); }
  }, [open, plan]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/platform/saas/plans/${plan.id}`, { method: 'PATCH', body: JSON.stringify({ name: f.name, priceMonthlyCop: Number(f.priceMonthlyCop), priceYearlyCop: Number(f.priceYearlyCop), trialDays: Number(f.trialDays) }) });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Editar plan"
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancelar</button><button className="btn" type="submit" form="plan-form" disabled={busy}>Guardar</button></>}>
      <form id="plan-form" className="stack" onSubmit={submit}>
        <label className="field">Nombre<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={3} /></label>
        <div className="grid2">
          <label className="field">Precio mensual (COP)<input type="number" min={0} step={1000} value={f.priceMonthlyCop} onChange={(e) => setF({ ...f, priceMonthlyCop: e.target.value })} required /></label>
          <label className="field">Precio anual (COP)<input type="number" min={0} step={1000} value={f.priceYearlyCop} onChange={(e) => setF({ ...f, priceYearlyCop: e.target.value })} required /></label>
        </div>
        <label className="field">Días de prueba para acueductos nuevos<input type="number" min={0} max={365} value={f.trialDays} onChange={(e) => setF({ ...f, trialDays: e.target.value })} required /></label>
        {error && <div className="alert alert-danger">{error}</div>}
      </form>
    </Modal>
  );
}

function SettingsModal({ open, settings, onClose, onSaved }: { open: boolean; settings: SaasSettings; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<SaasSettings>(settings);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setF(settings); setError(''); } }, [open, settings]);
  const bank = (k: keyof SaasSettings['bank'], v: string) => setF({ ...f, bank: { ...f.bank, [k]: v } as SaasSettings['bank'] });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/platform/saas/settings', { method: 'PUT', body: JSON.stringify(f) });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Medios de pago y plazos" size="lg"
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancelar</button><button className="btn" type="submit" form="settings-form" disabled={busy}>Guardar</button></>}>
      <form id="settings-form" className="stack" onSubmit={submit}>
        <div className="grid2">
          <label className="field">Emitir la factura (días antes del corte)<input type="number" min={0} max={60} value={f.invoiceLeadDays} onChange={(e) => setF({ ...f, invoiceLeadDays: Number(e.target.value) })} required /></label>
          <label className="field">Días de gracia antes de solo lectura<input type="number" min={0} max={60} value={f.graceDays} onChange={(e) => setF({ ...f, graceDays: Number(e.target.value) })} required /></label>
        </div>
        <h3 style={{ margin: '8px 0 0' }}>Cuenta para transferencias</h3>
        <div className="grid2">
          <label className="field">Banco<input value={f.bank.bankName} onChange={(e) => bank('bankName', e.target.value)} maxLength={80} /></label>
          <label className="field">Tipo de cuenta
            <select value={f.bank.accountType} onChange={(e) => bank('accountType', e.target.value)}>
              <option value="ahorros">Ahorros</option><option value="corriente">Corriente</option>
            </select>
          </label>
          <label className="field">Número de cuenta<input value={f.bank.accountNumber} onChange={(e) => bank('accountNumber', e.target.value)} maxLength={40} /></label>
          <label className="field">Titular<input value={f.bank.holder} onChange={(e) => bank('holder', e.target.value)} maxLength={120} /></label>
          <label className="field">NIT o cédula del titular<input value={f.bank.holderId} onChange={(e) => bank('holderId', e.target.value)} maxLength={40} /></label>
        </div>
        <label className="field">Instrucciones (opcional)<textarea rows={2} maxLength={500} value={f.bank.instructions} onChange={(e) => bank('instructions', e.target.value)} placeholder="Ej.: escribe el NIT del acueducto en la descripción de la transferencia" /></label>
        <p className="small muted" style={{ margin: 0 }}>Mercado Pago se configura en el servidor con MP_ACCESS_TOKEN y MP_WEBHOOK_SECRET.</p>
        {error && <div className="alert alert-danger">{error}</div>}
      </form>
    </Modal>
  );
}

function ManualPaymentModal({ invoice, onClose, onSaved }: { invoice: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ method: 'transfer', reference: '', notes: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (invoice) { setF({ method: 'transfer', reference: '', notes: '' }); setError(''); } }, [invoice]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/platform/saas/invoices/${invoice.id}/manual-payment`, { method: 'POST', body: JSON.stringify({ method: f.method, reference: f.reference, ...(f.notes ? { notes: f.notes } : {}) }) });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={invoice !== null} onClose={onClose} title={`Registrar pago · factura N.º ${invoice?.number ?? ''}`}
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancelar</button><button className="btn" type="submit" form="manual-form" disabled={busy}>Registrar pago</button></>}>
      {invoice && (
        <form id="manual-form" className="stack" onSubmit={submit}>
          <p style={{ margin: 0 }}><strong>{invoice.organization.name}</strong> · {fmtMoney(invoice.amountCop)}. La suscripción queda al día hasta el {date(invoice.periodEnd)}.</p>
          <label className="field">Cómo se recibió
            <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
              <option value="transfer">Transferencia o consignación</option><option value="manual">Otro (efectivo, acuerdo)</option>
            </select>
          </label>
          <label className="field">Referencia<input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} required minLength={3} maxLength={80} autoFocus /></label>
          <label className="field">Notas (opcional)<textarea rows={2} maxLength={500} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
          {error && <div className="alert alert-danger">{error}</div>}
        </form>
      )}
    </Modal>
  );
}
