'use client';

import { useEffect, useRef, useState } from 'react';
import { PAYMENT_METHODS } from '@agua-mata/shared';
import { api } from '@/lib/api';
import { Modal } from './modal';
import { errorText, fmtMoney } from './ui';

export interface Statement {
  subscriber: { id: string; code: string; fullName: string; documentNumber: string; address: string };
  balance: number;
  overdueInvoices: number;
  openInvoices: { id: string; number: number; period: string; dueDate: string; outstanding: number; daysPastDue: number; status: string }[];
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Registrar un pago: buscar al suscriptor (referencia del recibo, código, documento o nombre),
 * ver su deuda y aplicar el pago. Se abona primero la factura más antigua.
 */
export function PaymentModal({ open, onClose, onSaved, subscriberId }: { open: boolean; onClose: () => void; onSaved: () => void; subscriberId?: string }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Statement[]>([]);
  const [selected, setSelected] = useState<Statement | null>(null);
  const [form, setForm] = useState({ amount: '', paidAt: today(), method: 'efectivo', reference: '', notes: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; number: number; balanceAfter: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function select(s: Statement) {
    setSelected(s);
    setForm((f) => ({ ...f, amount: String(s.balance) }));
  }

  useEffect(() => {
    if (!open) return;
    setQ(''); setResults([]); setSelected(null); setError(''); setDone(null);
    setForm({ amount: '', paidAt: today(), method: 'efectivo', reference: '', notes: '' });
    if (subscriberId) api<Statement>(`/payments/statement/${subscriberId}`).then(select).catch((e) => setError(errorText(e)));
  }, [open, subscriberId]);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!q.trim() || selected) { setResults([]); return; }
    timer.current = setTimeout(() => {
      api<Statement[]>(`/payments/lookup?q=${encodeURIComponent(q.trim())}`).then(setResults).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(timer.current);
  }, [q, selected]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const res = await api('/payments', {
        method: 'POST',
        body: JSON.stringify({
          subscriberId: selected.subscriber.id, amount: Number(form.amount.replace(/\./g, '').replace(',', '.')), paidAt: form.paidAt,
          method: form.method, reference: form.reference || undefined, notes: form.notes || undefined,
        }),
      });
      setDone(res);
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const footer = done ? (
    <>
      <a className="btn btn-secondary" href={`/recaudo/comprobante?id=${done.id}`} target="_blank" rel="noreferrer">Imprimir comprobante</a>
      <button className="btn" onClick={onClose}>Listo</button>
    </>
  ) : (
    <>
      <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
      <button className="btn" type="submit" form="payment-form" disabled={!selected || busy || selected.balance <= 0}>{busy ? 'Registrando…' : 'Registrar pago'}</button>
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title="Registrar pago" size="lg" footer={footer}>
      {done ? (
        <div className="stack">
          <div className="alert alert-ok">Pago registrado con el comprobante <strong>N.º {done.number}</strong>.</div>
          <p>Saldo pendiente de {selected?.subscriber.fullName}: <strong>{fmtMoney(done.balanceAfter)}</strong></p>
        </div>
      ) : (
        <form id="payment-form" className="stack" onSubmit={submit}>
          {!selected ? (
            <>
              <label className="field">Buscar suscriptor
                <span className="hint">Referencia del recibo (p. ej. 001-45), código, documento o nombre.</span>
                <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="001-45" />
              </label>
              {results.length > 0 && (
                <div className="card card-flush">
                  <table>
                    <tbody>
                      {results.map((s) => (
                        <tr key={s.subscriber.id} style={{ cursor: 'pointer' }} onClick={() => select(s)}>
                          <td><span className="mono">{s.subscriber.code}</span> · {s.subscriber.fullName}<div className="small muted">{s.subscriber.address}</div></td>
                          <td className="right mono">{s.balance > 0 ? fmtMoney(s.balance) : <span className="badge badge-ok">Al día</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {q.trim() && results.length === 0 && <p className="muted small">Sin resultados.</p>}
            </>
          ) : (
            <>
              <div className="row-between">
                <div>
                  <strong>{selected.subscriber.code} · {selected.subscriber.fullName}</strong>
                  <div className="small muted">{selected.subscriber.address} · Doc. {selected.subscriber.documentNumber}</div>
                </div>
                {!subscriberId && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSelected(null); setQ(''); }}>Cambiar</button>}
              </div>
              {selected.openInvoices.length === 0 ? (
                <div className="alert alert-ok">Este suscriptor está al día.</div>
              ) : (
                <div className="card card-flush">
                  <table>
                    <thead><tr><th>Factura</th><th>Período</th><th>Vence</th><th className="right">Saldo</th></tr></thead>
                    <tbody>
                      {selected.openInvoices.map((i) => (
                        <tr key={i.id}>
                          <td className="mono">N.º {i.number}</td>
                          <td>{i.period}</td>
                          <td>{i.dueDate}{i.daysPastDue > 0 && <span className="badge badge-danger" style={{ marginLeft: 6 }}>{i.daysPastDue} días</span>}</td>
                          <td className="right mono">{fmtMoney(i.outstanding)}</td>
                        </tr>
                      ))}
                      <tr><td colSpan={3}><strong>Deuda total</strong></td><td className="right mono"><strong>{fmtMoney(selected.balance)}</strong></td></tr>
                    </tbody>
                  </table>
                </div>
              )}
              <div className="grid2">
                <label className="field">Valor recibido
                  <input inputMode="numeric" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
                  <span className="hint">Se abona primero la factura más antigua. Puede ser un abono parcial.</span>
                </label>
                <label className="field">Fecha del pago<input type="date" max={today()} value={form.paidAt} onChange={(e) => setForm({ ...form, paidAt: e.target.value })} required /></label>
                <label className="field">Medio de pago
                  <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
                    {PAYMENT_METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </label>
                <label className="field">Referencia bancaria (opcional)<input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} maxLength={80} /></label>
              </div>
              <label className="field">Observación (opcional)<input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={300} /></label>
            </>
          )}
          {error && <div className="alert alert-danger">{error}</div>}
        </form>
      )}
    </Modal>
  );
}
