'use client';

import { useCallback, useEffect, useState } from 'react';
import { PAYMENT_METHODS } from '@agua-mata/shared';
import { api } from '@/lib/api';
import { isAdminRole, useMe } from '@/components/app-shell';
import { ConfirmModal } from '@/components/modal';
import { PaymentModal } from '@/components/payment-modal';
import { Empty, errorText, fmtMoney, fmtNumber, Icon, PageHeader, Stat } from '@/components/ui';

const METHOD = Object.fromEntries(PAYMENT_METHODS) as Record<string, string>;
const today = () => new Date().toISOString().slice(0, 10);

export default function RecaudoPage() {
  const { me } = useMe();
  const [range, setRange] = useState({ from: today(), to: today() });
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [payOpen, setPayOpen] = useState(false);
  const [voiding, setVoiding] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState('');
  const canPay = me.role !== 'reader';

  const load = useCallback(() => {
    api(`/payments?from=${range.from}&to=${range.to}`).then(setData).catch((e) => setError(errorText(e)));
  }, [range]);
  useEffect(() => { load(); }, [load]);

  async function voidPayment(reason: string) {
    setBusy(true);
    setModalError('');
    try {
      await api(`/payments/${voiding.id}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
      setVoiding(null);
      load();
    } catch (e) {
      setModalError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Recaudo"
        description="Registra los pagos de los suscriptores. Cada pago se abona primero a la factura más antigua."
        actions={canPay && <button className="btn" onClick={() => setPayOpen(true)}><Icon name="plus" /> Registrar pago</button>}
      />
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="grid-stats" style={{ marginBottom: 16 }}>
        <Stat label="Total recaudado" value={fmtMoney(data?.total)} sub={`${fmtNumber(data?.count)} pagos`} />
        {PAYMENT_METHODS.filter(([m]) => data?.byMethod?.[m]).map(([m, l]) => (
          <Stat key={m} label={l} value={fmtMoney(data.byMethod[m])} />
        ))}
      </div>

      <section className="card card-flush">
        <div className="card-head">
          <div className="row">
            <label className="field">Desde<input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
            <label className="field">Hasta<input type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
            <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'end' }} onClick={() => setRange({ from: today(), to: today() })}>Hoy</button>
          </div>
        </div>
        {!data ? <p className="muted" style={{ padding: 20 }}>Cargando…</p> : data.payments.length === 0 ? (
          <Empty title="No hay pagos en estas fechas">{canPay && <button className="btn" onClick={() => setPayOpen(true)}>Registrar un pago</button>}</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Comprobante</th><th>Fecha</th><th>Suscriptor</th><th>Medio</th><th className="right">Valor</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {data.payments.map((p: any) => (
                  <tr key={p.id} style={p.status === 'void' ? { opacity: 0.6 } : undefined}>
                    <td className="mono">N.º {p.number}</td>
                    <td>{p.paidAt}</td>
                    <td><span className="mono">{p.subscriber.code}</span> · {p.subscriber.fullName}</td>
                    <td>{METHOD[p.method] ?? p.method}{p.reference && <div className="small muted">{p.reference}</div>}</td>
                    <td className="right mono"><strong>{fmtMoney(p.amount)}</strong></td>
                    <td><span className={`badge ${p.status === 'void' ? 'badge-danger' : 'badge-ok'}`}>{p.status === 'void' ? 'Anulado' : 'Aplicado'}</span></td>
                    <td className="right">
                      <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                        <a className="btn btn-secondary btn-sm" href={`/recaudo/comprobante?id=${p.id}`}>Comprobante</a>
                        {p.status === 'applied' && isAdminRole(me.role) && (
                          <button className="btn btn-ghost btn-sm" onClick={() => { setModalError(''); setVoiding(p); }}>Anular</button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <PaymentModal open={payOpen} onClose={() => setPayOpen(false)} onSaved={load} />
      <ConfirmModal
        open={voiding !== null}
        onClose={() => setVoiding(null)}
        onConfirm={voidPayment}
        danger
        busy={busy}
        error={modalError}
        title={`Anular comprobante N.º ${voiding?.number ?? ''}`}
        confirmLabel="Anular pago"
        reasonLabel="Motivo (queda en la auditoría)"
        message={<p>El valor de <strong>{fmtMoney(voiding?.amount)}</strong> volverá a quedar como deuda de {voiding?.subscriber.fullName}.</p>}
      />
    </>
  );
}
