'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AGING_BUCKETS, PAYMENT_METHODS } from '@agua-mata/shared';
import { api } from '@/lib/api';
import { useMe } from '@/components/app-shell';
import { Modal } from '@/components/modal';
import { PaymentModal } from '@/components/payment-modal';
import { Empty, errorText, fmtMoney, fmtNumber, PageHeader, Stat } from '@/components/ui';

const METHOD = Object.fromEntries(PAYMENT_METHODS) as Record<string, string>;
const today = () => new Date().toISOString().slice(0, 10);

export default function CarteraPage() {
  const { me } = useMe();
  const [asOf, setAsOf] = useState(today());
  const [minOverdue, setMinOverdue] = useState(2);
  const [view, setView] = useState<'all' | 'suspension'>('all');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [statement, setStatement] = useState<any>(null);
  const [payFor, setPayFor] = useState<string | null>(null);
  const canPay = me.role !== 'reader';

  const load = useCallback(() => {
    api(`/receivables?asOf=${asOf}&minOverdue=${minOverdue}`).then(setData).catch((e) => setError(errorText(e)));
  }, [asOf, minOverdue]);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => (data ? (view === 'suspension' ? data.rows.filter((r: any) => r.suspensionCandidate) : data.rows) : []), [data, view]);

  async function openStatement(subscriberId: string) {
    setStatement({ loading: true });
    try {
      setStatement(await api(`/payments/statement/${subscriberId}`));
    } catch (e) {
      setStatement({ error: errorText(e) });
    }
  }

  return (
    <>
      <PageHeader title="Cartera" description="Lo que deben los suscriptores, por antigüedad de la deuda." />
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="grid-stats" style={{ marginBottom: 16 }}>
        <Stat label="Cartera total" value={fmtMoney(data?.total)} sub={`${fmtNumber(data?.subscribersWithDebt)} suscriptores con saldo`} />
        <Stat label="Vencida" value={fmtMoney(data?.overdue)} progress={data?.total ? data.overdue / data.total : 0} />
        {AGING_BUCKETS.map(([k, l]) => <Stat key={k} label={l} value={fmtMoney(data?.buckets?.[k])} />)}
        <Stat label="Para suspensión" value={fmtNumber(data?.suspensionCandidates)} sub={`${minOverdue} o más facturas vencidas`} />
      </div>

      <section className="card card-flush">
        <div className="card-head">
          <div className="row">
            <label className="field">Fecha de corte<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
            <label className="field">Suspender con
              <select value={minOverdue} onChange={(e) => setMinOverdue(Number(e.target.value))}>
                {[1, 2, 3].map((n) => <option key={n} value={n}>{n} factura{n > 1 ? 's' : ''} vencida{n > 1 ? 's' : ''}</option>)}
              </select>
            </label>
          </div>
          <div className="tabs" role="tablist" style={{ border: 0 }}>
            <button role="tab" className="tab" aria-selected={view === 'all'} onClick={() => setView('all')}>Todos</button>
            <button role="tab" className="tab" aria-selected={view === 'suspension'} onClick={() => setView('suspension')}>Lista de suspensión</button>
          </div>
        </div>
        {view === 'suspension' && (
          <div className="alert alert-info" style={{ margin: 16 }}>
            La Ley 142 de 1994 (art. 140, modificado por la Ley 689 de 2001) permite suspender por falta de pago sin exceder 3 períodos
            en facturación mensual o 2 en bimestral. Antes de suspender, verifica el debido proceso y que no haya reclamaciones en trámite.
          </div>
        )}
        {!data ? <p className="muted" style={{ padding: 20 }}>Cargando…</p> : rows.length === 0 ? (
          <Empty title={view === 'suspension' ? 'Nadie cumple el criterio de suspensión' : 'No hay cartera pendiente'} />
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
                {rows.map((r: any) => (
                  <tr key={r.subscriber.id}>
                    <td>
                      <span className="mono">{r.subscriber.code}</span> · {r.subscriber.fullName}
                      {r.suspensionCandidate && <span className="badge badge-danger" style={{ marginLeft: 6 }}>Suspensión</span>}
                      <div className="small muted">{r.subscriber.address}</div>
                    </td>
                    <td className="right mono">{r.overdueInvoices}</td>
                    <td className="right mono">{r.maxDaysPastDue ? `${r.maxDaysPastDue} d` : '—'}</td>
                    {AGING_BUCKETS.map(([k]) => <td key={k} className="right mono">{r.buckets[k] ? fmtMoney(r.buckets[k]) : '—'}</td>)}
                    <td className="right mono"><strong>{fmtMoney(r.balance)}</strong></td>
                    <td className="right">
                      <span className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'nowrap' }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => openStatement(r.subscriber.id)}>Estado de cuenta</button>
                        {canPay && <button className="btn btn-sm" onClick={() => setPayFor(r.subscriber.id)}>Pagar</button>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal open={statement !== null} onClose={() => setStatement(null)} title="Estado de cuenta" size="lg"
        footer={statement?.subscriber && canPay && <button className="btn" onClick={() => { const id = statement.subscriber.id; setStatement(null); setPayFor(id); }}>Registrar pago</button>}>
        {statement?.loading && <p className="muted">Cargando…</p>}
        {statement?.error && <div className="alert alert-danger">{statement.error}</div>}
        {statement?.subscriber && (
          <div className="stack">
            <div className="row-between">
              <div><strong>{statement.subscriber.code} · {statement.subscriber.fullName}</strong><div className="small muted">{statement.subscriber.address}</div></div>
              <div className="right"><div className="small muted">Saldo</div><strong style={{ fontSize: 20 }}>{fmtMoney(statement.balance)}</strong></div>
            </div>
            <h3>Facturas</h3>
            <div className="card card-flush table-wrap">
              <table>
                <thead><tr><th>N.º</th><th>Período</th><th>Vence</th><th className="right">Total</th><th className="right">Abonado</th><th className="right">Saldo</th><th></th></tr></thead>
                <tbody>
                  {statement.invoices.map((i: any) => (
                    <tr key={i.id}>
                      <td className="mono">{i.number}</td><td>{i.period}</td>
                      <td>{i.dueDate}{i.daysPastDue > 0 && <span className="badge badge-danger" style={{ marginLeft: 6 }}>{i.daysPastDue} d</span>}</td>
                      <td className="right mono">{fmtMoney(i.total)}</td><td className="right mono">{fmtMoney(i.paidAmount)}</td>
                      <td className="right mono">{i.outstanding > 0 ? <strong>{fmtMoney(i.outstanding)}</strong> : <span className="badge badge-ok">Pagada</span>}</td>
                      <td className="right"><a className="btn btn-ghost btn-sm" href={`/facturacion/recibo?id=${i.id}`}>Recibo</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>Pagos</h3>
            {statement.payments.length === 0 ? <p className="muted small">Sin pagos registrados.</p> : (
              <div className="card card-flush table-wrap">
                <table>
                  <thead><tr><th>Comprobante</th><th>Fecha</th><th>Medio</th><th>Aplicado a</th><th className="right">Valor</th></tr></thead>
                  <tbody>
                    {statement.payments.map((p: any) => (
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
          </div>
        )}
      </Modal>

      <PaymentModal open={payFor !== null} subscriberId={payFor ?? undefined} onClose={() => setPayFor(null)} onSaved={load} />
    </>
  );
}
