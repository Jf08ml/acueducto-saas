'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AGING_BUCKETS, PAYMENT_METHODS } from '@agua-mata/shared';
import { api } from '@/lib/api';
import { isAdminRole, useMe } from '@/components/app-shell';
import { Modal } from '@/components/modal';
import { PaymentModal } from '@/components/payment-modal';
import { Empty, errorText, fmtMoney, fmtNumber, PageHeader, Stat } from '@/components/ui';

const METHOD = Object.fromEntries(PAYMENT_METHODS) as Record<string, string>;
const today = () => new Date().toISOString().slice(0, 10);

export default function CarteraPage() {
  const { me } = useMe();
  const [asOf, setAsOf] = useState(today());
  const [minOverdue, setMinOverdue] = useState<number | null>(null);
  const [view, setView] = useState<'all' | 'suspension' | 'suspended'>('all');
  const [data, setData] = useState<any>(null);
  const [settings, setSettings] = useState<any>(null);
  const [error, setError] = useState('');
  const [statementId, setStatementId] = useState<string | null>(null);
  const [payFor, setPayFor] = useState<string | null>(null);
  const [service, setService] = useState<{ row: any; action: 'suspend' | 'reconnect' } | null>(null);
  const canPay = me.role !== 'reader';
  const canManage = isAdminRole(me.role);

  const load = useCallback(() => {
    const q = new URLSearchParams({ asOf, ...(minOverdue ? { minOverdue: String(minOverdue) } : {}) });
    api(`/receivables?${q}`).then((d) => { setData(d); setMinOverdue((m) => m ?? d.minOverdue); }).catch((e) => setError(errorText(e)));
  }, [asOf, minOverdue]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api('/collections/settings').then(setSettings).catch(() => undefined); }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    if (view === 'suspension') return data.rows.filter((r: any) => r.suspensionCandidate);
    if (view === 'suspended') return data.rows.filter((r: any) => r.subscriber.serviceStatus === 'suspended');
    return data.rows;
  }, [data, view]);

  return (
    <>
      <PageHeader title="Cartera" description="Lo que deben los suscriptores, por antigüedad de la deuda." />
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="grid-stats" style={{ marginBottom: 16 }}>
        <Stat label="Cartera total" value={fmtMoney(data?.total)} sub={`${fmtNumber(data?.subscribersWithDebt)} suscriptores con saldo`} />
        <Stat label="Vencida" value={fmtMoney(data?.overdue)} progress={data?.total ? data.overdue / data.total : 0} />
        {AGING_BUCKETS.map(([k, l]) => <Stat key={k} label={l} value={fmtMoney(data?.buckets?.[k])} />)}
        <Stat label="Para suspensión" value={fmtNumber(data?.suspensionCandidates)} sub={`${data?.minOverdue ?? '—'} o más facturas vencidas`} />
        <Stat label="Suspendidos" value={fmtNumber(data?.suspended)} />
      </div>

      <section className="card card-flush">
        <div className="card-head">
          <div className="row">
            <label className="field">Fecha de corte<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
            <label className="field">Suspender con
              <select value={minOverdue ?? ''} onChange={(e) => setMinOverdue(Number(e.target.value))}>
                {[1, 2, 3].map((n) => <option key={n} value={n}>{n} factura{n > 1 ? 's' : ''} vencida{n > 1 ? 's' : ''}</option>)}
              </select>
            </label>
          </div>
          <div className="tabs" role="tablist" style={{ border: 0 }}>
            <button role="tab" className="tab" aria-selected={view === 'all'} onClick={() => setView('all')}>Todos</button>
            <button role="tab" className="tab" aria-selected={view === 'suspension'} onClick={() => setView('suspension')}>Lista de suspensión</button>
            <button role="tab" className="tab" aria-selected={view === 'suspended'} onClick={() => setView('suspended')}>Suspendidos</button>
          </div>
        </div>
        {view === 'suspension' && (
          <div className="alert alert-info" style={{ margin: 16 }}>
            La Ley 142 de 1994 (art. 140, modificado por la Ley 689 de 2001) permite suspender por falta de pago sin exceder 3 períodos
            en facturación mensual o 2 en bimestral. Antes de suspender, verifica el debido proceso y que no haya reclamaciones en trámite.
          </div>
        )}
        {!data ? <p className="muted" style={{ padding: 20 }}>Cargando…</p> : rows.length === 0 ? (
          <Empty title={view === 'suspension' ? 'Nadie cumple el criterio de suspensión' : view === 'suspended' ? 'No hay suscriptores suspendidos con deuda' : 'No hay cartera pendiente'} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Suscriptor</th><th className="right">Vencidas</th><th className="right">Mora</th>
                  {AGING_BUCKETS.map(([k, l]) => <th key={k} className="right">{l}</th>)}
                  <th className="right">Saldo</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any) => {
                  const suspended = r.subscriber.serviceStatus === 'suspended';
                  return (
                    <tr key={r.subscriber.id}>
                      <td>
                        <span className="mono">{r.subscriber.code}</span> · {r.subscriber.fullName}
                        {suspended && <span className="badge badge-danger" style={{ marginLeft: 6 }}>Suspendido</span>}
                        {r.suspensionCandidate && <span className="badge badge-warn" style={{ marginLeft: 6 }}>Para suspender</span>}
                        <div className="small muted">{r.subscriber.address}</div>
                      </td>
                      <td className="right mono">{r.overdueInvoices}</td>
                      <td className="right mono">{r.maxDaysPastDue ? `${r.maxDaysPastDue} d` : '—'}</td>
                      {AGING_BUCKETS.map(([k]) => <td key={k} className="right mono">{r.buckets[k] ? fmtMoney(r.buckets[k]) : '—'}</td>)}
                      <td className="right mono"><strong>{fmtMoney(r.balance)}</strong></td>
                      <td className="right">
                        <span className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'nowrap' }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => setStatementId(r.subscriber.id)}>Estado de cuenta</button>
                          {canPay && <button className="btn btn-sm" onClick={() => setPayFor(r.subscriber.id)}>Pagar</button>}
                          {canManage && (suspended
                            ? <button className="btn btn-secondary btn-sm" onClick={() => setService({ row: r, action: 'reconnect' })}>Reconectar</button>
                            : <button className="btn btn-ghost btn-sm" onClick={() => setService({ row: r, action: 'suspend' })}>Suspender</button>)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <StatementModal subscriberId={statementId} onClose={() => setStatementId(null)} canManage={canManage}
        onPay={(id) => { setStatementId(null); setPayFor(id); }} canPay={canPay} />
      <PaymentModal open={payFor !== null} subscriberId={payFor ?? undefined} onClose={() => setPayFor(null)} onSaved={load} />
      <ServiceModal state={service} settings={settings} onClose={() => setService(null)} onDone={() => { setService(null); load(); }} />
    </>
  );
}

function ServiceModal({ state, settings, onClose, onDone }: { state: { row: any; action: 'suspend' | 'reconnect' } | null; settings: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ date: today(), reason: '', notes: '', fee: '', allowWithDebt: false });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (state) { setF({ date: today(), reason: '', notes: '', fee: String(settings?.reconnectionFee ?? 0), allowWithDebt: false }); setError(''); }
  }, [state, settings]);
  if (!state) return <Modal open={false} onClose={onClose} title="">{null}</Modal>;
  const { row, action } = state;
  const debt = row.balance > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (action === 'suspend') {
        await api(`/collections/subscribers/${row.subscriber.id}/suspend`, { method: 'POST', body: JSON.stringify({ date: f.date, reason: f.reason, notes: f.notes || undefined }) });
      } else {
        await api(`/collections/subscribers/${row.subscriber.id}/reconnect`, {
          method: 'POST',
          body: JSON.stringify({ date: f.date, notes: f.notes || undefined, reconnectionFee: Number(f.fee || 0), allowWithDebt: debt && f.allowWithDebt }),
        });
      }
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={action === 'suspend' ? 'Suspender servicio' : 'Reconectar servicio'}
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
        <button className={`btn ${action === 'suspend' ? 'btn-danger' : ''}`} type="submit" form="service-form" disabled={busy || (action === 'reconnect' && debt && !f.allowWithDebt)}>
          {action === 'suspend' ? 'Registrar suspensión' : 'Registrar reconexión'}
        </button></>}>
      <form id="service-form" className="stack" onSubmit={submit}>
        <p><strong>{row.subscriber.code} · {row.subscriber.fullName}</strong> — saldo {fmtMoney(row.balance)}{row.overdueInvoices ? `, ${row.overdueInvoices} facturas vencidas` : ''}.</p>
        <label className="field">Fecha<input type="date" value={f.date} max={today()} onChange={(e) => setF({ ...f, date: e.target.value })} required /></label>
        {action === 'suspend' ? (
          <>
            <label className="field">Motivo<input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={5} placeholder="Falta de pago: 2 facturas vencidas" /></label>
            <label className="field">Observaciones (opcional)<textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
            <p className="small muted">Antes de suspender verifica el debido proceso (aviso previo y que no haya reclamaciones en trámite).</p>
          </>
        ) : (
          <>
            <label className="field">Cargo por reconexión ($)<span className="hint">Se suma a la próxima factura. 0 = sin cargo.</span>
              <input inputMode="numeric" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value.replace(/[^\d]/g, '') })} />
            </label>
            {debt && (
              <>
                <div className="alert alert-warn">El suscriptor aún debe {fmtMoney(row.balance)}. Lo usual es reconectar cuando paga.</div>
                <label className="radio-card">
                  <input type="checkbox" checked={f.allowWithDebt} onChange={(e) => setF({ ...f, allowWithDebt: e.target.checked })} />
                  <span><strong>Reconectar con deuda</strong><br /><span className="muted">Por ejemplo, por un acuerdo de pago. Queda registrado en el historial.</span></span>
                </label>
              </>
            )}
            <label className="field">{debt ? 'Motivo o acuerdo de pago' : 'Observaciones (opcional)'}
              <textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} required={debt && f.allowWithDebt} minLength={debt && f.allowWithDebt ? 5 : undefined} />
            </label>
          </>
        )}
        {error && <div className="alert alert-danger">{error}</div>}
      </form>
    </Modal>
  );
}

function StatementModal({ subscriberId, onClose, onPay, canPay, canManage }: { subscriberId: string | null; onClose: () => void; onPay: (id: string) => void; canPay: boolean; canManage: boolean }) {
  const [st, setSt] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [charge, setCharge] = useState({ description: '', amount: '' });
  const [chargeOpen, setChargeOpen] = useState(false);

  const load = useCallback(async () => {
    if (!subscriberId) return;
    setError('');
    try {
      const [s, ev] = await Promise.all([api(`/payments/statement/${subscriberId}`), api(`/collections/subscribers/${subscriberId}/events`)]);
      setSt(s);
      setEvents(ev.events);
    } catch (e) {
      setError(errorText(e));
    }
  }, [subscriberId]);
  useEffect(() => { setSt(null); setEvents([]); setChargeOpen(false); load(); }, [load]);

  async function addCharge(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api('/collections/charges', { method: 'POST', body: JSON.stringify({ subscriberId, description: charge.description, amount: Number(charge.amount) }) });
      setCharge({ description: '', amount: '' });
      setChargeOpen(false);
      load();
    } catch (err) {
      setError(errorText(err));
    }
  }
  async function voidCharge(id: string) {
    try {
      await api(`/collections/charges/${id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Modal open={subscriberId !== null} onClose={onClose} title="Estado de cuenta" size="lg"
      footer={st && canPay && <button className="btn" onClick={() => onPay(st.subscriber.id)}>Registrar pago</button>}>
      {error && <div className="alert alert-danger">{error}</div>}
      {!st ? <p className="muted">Cargando…</p> : (
        <div className="stack">
          <div className="row-between">
            <div>
              <strong>{st.subscriber.code} · {st.subscriber.fullName}</strong>
              {st.subscriber.serviceStatus === 'suspended' && <span className="badge badge-danger" style={{ marginLeft: 6 }}>Servicio suspendido</span>}
              <div className="small muted">{st.subscriber.address}</div>
            </div>
            <div className="right"><div className="small muted">Saldo</div><strong style={{ fontSize: 20 }}>{fmtMoney(st.balance)}</strong></div>
          </div>

          <h3>Facturas</h3>
          <div className="card card-flush table-wrap">
            <table>
              <thead><tr><th>N.º</th><th>Período</th><th>Vence</th><th className="right">Total</th><th className="right">Abonado</th><th className="right">Saldo</th><th></th></tr></thead>
              <tbody>
                {st.invoices.map((i: any) => (
                  <tr key={i.id}>
                    <td className="mono">{i.number}</td><td>{i.period}</td>
                    <td>{i.dueDate}{i.daysPastDue > 0 && <span className="badge badge-danger" style={{ marginLeft: 6 }}>{i.daysPastDue} d</span>}</td>
                    <td className="right mono">{fmtMoney(i.total)}</td><td className="right mono">{fmtMoney(i.paidAmount)}</td>
                    <td className="right mono">{i.outstanding > 0 ? <strong>{fmtMoney(i.outstanding)}</strong> : <span className="badge badge-ok">Pagada</span>}</td>
                    <td className="right"><a className="btn btn-ghost btn-sm" href={`/facturacion/recibo?id=${i.id}`}>Recibo</a></td>
                  </tr>
                ))}
                {st.invoices.length === 0 && <tr><td colSpan={7} className="muted">Sin facturas.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="row-between">
            <h3>Cargos pendientes de facturar</h3>
            {canManage && !chargeOpen && <button className="btn btn-secondary btn-sm" onClick={() => setChargeOpen(true)}>Agregar cargo</button>}
          </div>
          {chargeOpen && (
            <form className="row" onSubmit={addCharge}>
              <input placeholder="Concepto (p. ej. arreglo de acometida)" value={charge.description} onChange={(e) => setCharge({ ...charge, description: e.target.value })} required minLength={3} style={{ flex: 2, minWidth: 200 }} autoFocus />
              <input placeholder="Valor" inputMode="numeric" value={charge.amount} onChange={(e) => setCharge({ ...charge, amount: e.target.value.replace(/[^\d]/g, '') })} required style={{ flex: 1, minWidth: 100 }} />
              <button className="btn btn-sm" type="submit">Agregar</button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setChargeOpen(false)}>Cancelar</button>
            </form>
          )}
          {st.pendingCharges.length === 0 ? <p className="muted small">No hay cargos pendientes. Se suman automáticamente a la siguiente factura.</p> : (
            <div className="card card-flush table-wrap">
              <table>
                <tbody>
                  {st.pendingCharges.map((c: any) => (
                    <tr key={c.id}>
                      <td>{c.description}</td><td className="right mono">{fmtMoney(c.amount)}</td>
                      <td className="right">{canManage && <button className="btn btn-ghost btn-sm" onClick={() => voidCharge(c.id)}>Anular</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3>Pagos</h3>
          {st.payments.length === 0 ? <p className="muted small">Sin pagos registrados.</p> : (
            <div className="card card-flush table-wrap">
              <table>
                <thead><tr><th>Comprobante</th><th>Fecha</th><th>Medio</th><th>Aplicado a</th><th className="right">Valor</th></tr></thead>
                <tbody>
                  {st.payments.map((p: any) => (
                    <tr key={p.id} style={p.status === 'void' ? { opacity: 0.55, textDecoration: 'line-through' } : undefined}>
                      <td><a className="mono" href={`/recaudo/comprobante?id=${p.id}`}>N.º {p.number}</a></td>
                      <td>{p.paidAt}</td><td>{METHOD[p.method] ?? p.method}</td>
                      <td className="small">{p.allocations.map((a: any) => `${a.period}: ${fmtMoney(a.amount)}`).join(' · ')}</td>
                      <td className="right mono">{fmtMoney(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {events.length > 0 && (
            <>
              <h3>Historial del servicio</h3>
              <div className="card card-flush table-wrap">
                <table>
                  <tbody>
                    {events.map((e) => (
                      <tr key={e.id}>
                        <td>{e.date.slice(0, 10)}</td>
                        <td><span className={`badge ${e.type === 'suspension' ? 'badge-danger' : 'badge-ok'}`}>{e.type === 'suspension' ? 'Suspensión' : 'Reconexión'}</span></td>
                        <td>{e.reason}{e.notes && <div className="small muted">{e.notes}</div>}</td>
                        <td className="right small muted">Saldo {fmtMoney(e.balanceAtEvent)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
