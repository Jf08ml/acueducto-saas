'use client';

import { useCallback, useEffect, useState } from 'react';
import { CYCLE_LABEL, SAAS_INVOICE_STATUS_LABEL, SAAS_PAYMENT_METHOD_LABEL, SUBSCRIPTION_STATUS_LABEL } from '@agua-mata/shared';
import { api, apiOpen, apiUpload } from '@/lib/api';
import { useMe } from '@/components/app-shell';
import { Modal } from '@/components/modal';
import { Empty, errorText, fmtMoney, Icon, PageHeader, Stat } from '@/components/ui';

const date = (d?: string | null) => (d ? new Date(d).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const STATUS_BADGE: Record<string, string> = { trialing: 'badge-info', active: 'badge-ok', past_due: 'badge-warn', suspended: 'badge-danger', cancelled: '' };
const INVOICE_BADGE: Record<string, string> = { pending: 'badge-warn', in_review: 'badge-info', paid: 'badge-ok', void: '' };
const PAYMENT_STATUS: Record<string, [string, string]> = {
  in_review: ['En revisión', 'badge-info'], approved: ['Aprobado', 'badge-ok'], rejected: ['Rechazado', 'badge-danger'], pending: ['Pendiente', 'badge-warn'],
};

interface Overview {
  subscription: null | {
    status: string; billingCycle: 'monthly' | 'yearly'; trialEndsAt: string | null; currentPeriodStart: string; currentPeriodEnd: string; graceEndsAt: string | null;
    plan: { name: string; priceMonthlyCop: number; priceYearlyCop: number };
  };
  invoices: any[];
  payments: any[];
  payWith: { mercadoPago: boolean; transfer: boolean };
  bank: null | { bankName: string; accountType: string; accountNumber: string; holder: string; holderId: string; instructions: string };
}

/** Suscripción del acueducto a AguaMata: estado, factura por pagar, pago con Mercado Pago o transferencia e historial. */
export default function SuscripcionPage() {
  const { reload: reloadMe } = useMe();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'info' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<Overview>('/subscription'));
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  // Regreso desde Mercado Pago: ?factura=...&payment_id=... (o collection_id). Se confirma consultando el pago.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const invoiceId = q.get('factura');
    const paymentId = q.get('payment_id') ?? q.get('collection_id');
    window.history.replaceState(null, '', '/suscripcion');
    (async () => {
      if (invoiceId && paymentId && /^\d+$/.test(paymentId)) {
        try {
          const r = await api(`/subscription/invoices/${invoiceId}/mercadopago/sync`, { method: 'POST', body: JSON.stringify({ paymentId }) });
          if (r.invoiceStatus === 'paid') setNotice({ kind: 'ok', text: '¡Pago recibido! Tu suscripción quedó al día.' });
          else if (r.status === 'pending') setNotice({ kind: 'info', text: 'Mercado Pago aún está procesando el pago. Te avisaremos por correo cuando se confirme.' });
          else setNotice({ kind: 'danger', text: 'El pago no se aprobó. Puedes intentarlo de nuevo o pagar por transferencia.' });
          await reloadMe();
        } catch (e) {
          setNotice({ kind: 'danger', text: errorText(e) });
        }
      } else if (invoiceId && q.get('status') === 'null') {
        setNotice({ kind: 'info', text: 'Cancelaste el pago en Mercado Pago. La factura sigue pendiente.' });
      }
      await load();
    })();
  }, [load, reloadMe]);

  async function payWithMp(invoiceId: string) {
    setBusy(true);
    setNotice(null);
    try {
      const { url } = await api<{ url: string }>(`/subscription/invoices/${invoiceId}/mercadopago`, { method: 'POST' });
      window.location.href = url;
    } catch (e) {
      setNotice({ kind: 'danger', text: errorText(e) });
      setBusy(false);
    }
  }

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!data) return <p className="muted">Cargando…</p>;

  const sub = data.subscription;
  const open = data.invoices.find((i) => i.status === 'pending' || i.status === 'in_review');
  const price = sub ? (sub.billingCycle === 'yearly' ? sub.plan.priceYearlyCop : sub.plan.priceMonthlyCop) : 0;
  const review = open ? data.payments.find((p) => p.invoiceId === open.id && p.status === 'in_review') : null;
  const lastRejected = open ? data.payments.find((p) => p.invoiceId === open.id && p.status === 'rejected' && p.method === 'transfer') : null;

  return (
    <div className="stack">
      <PageHeader title="Suscripción" description="Tu plan de AguaMata, las facturas de la plataforma y cómo pagarlas." />
      {notice && <div className={`alert alert-${notice.kind}`} role="status">{notice.text}</div>}

      {sub?.status === 'suspended' && (
        <div className="alert alert-danger">
          <strong>La cuenta está en modo de solo lectura por falta de pago.</strong> Puedes consultar y descargar tu información, pero no registrar cambios.
          En cuanto se confirme el pago, la cuenta se reactiva. No se borra ningún dato.
        </div>
      )}
      {sub?.status === 'past_due' && (
        <div className="alert alert-warn">
          Tu factura está vencida. Tienes hasta el <strong>{date(sub.graceEndsAt)}</strong> para pagar; después la cuenta quedará en modo de solo lectura.
        </div>
      )}

      {sub && (
        <div className="grid-stats">
          <Stat label="Plan" value={sub.plan.name} sub={`${CYCLE_LABEL[sub.billingCycle]} · ${fmtMoney(price)}`} />
          <Stat label="Estado" value={<span className={`badge ${STATUS_BADGE[sub.status] ?? ''}`}>{SUBSCRIPTION_STATUS_LABEL[sub.status] ?? sub.status}</span>} />
          <Stat label={sub.status === 'trialing' ? 'La prueba termina' : 'Período actual hasta'} value={date(sub.currentPeriodEnd)} />
        </div>
      )}

      <section className="card stack">
        <h2 style={{ margin: 0 }}>Factura por pagar</h2>
        {!open ? (
          <p className="muted" style={{ margin: 0 }}>
            No tienes facturas pendientes.{sub ? ` La próxima factura se emite unos días antes del ${date(sub.currentPeriodEnd)} y te avisamos por correo.` : ''}
          </p>
        ) : (
          <>
            <div className="row-between">
              <div className="stack-sm">
                <strong>Factura N.º {open.number} · {fmtMoney(open.amountCop)}</strong>
                <span className="muted small">Del {date(open.periodStart)} al {date(open.periodEnd)} · {CYCLE_LABEL[open.billingCycle as 'monthly']} · Pagar antes del {date(open.dueDate)}</span>
              </div>
              <span className={`badge ${INVOICE_BADGE[open.status]}`}>{SAAS_INVOICE_STATUS_LABEL[open.status]}</span>
            </div>
            {open.status === 'in_review' ? (
              <div className="alert alert-info">
                Recibimos tu transferencia{review?.reference ? ` (referencia ${review.reference})` : ''}. La estamos revisando; te avisaremos por correo cuando quede aprobada.
              </div>
            ) : (
              <>
                {lastRejected && <div className="alert alert-warn">La transferencia que reportaste no se aprobó: {lastRejected.rejectReason}</div>}
                <div className="row">
                  {data.payWith.mercadoPago && (
                    <button className="btn" disabled={busy} onClick={() => payWithMp(open.id)}>
                      <Icon name="cash" /> {busy ? 'Abriendo Mercado Pago…' : 'Pagar con Mercado Pago'}
                    </button>
                  )}
                  {data.payWith.transfer && (
                    <button className="btn btn-secondary" onClick={() => setTransferOpen(true)}>Reportar transferencia</button>
                  )}
                </div>
                {!data.payWith.mercadoPago && !data.payWith.transfer && (
                  <div className="alert alert-info">Aún no hay medios de pago configurados. Escríbenos para registrar tu pago.</div>
                )}
                {data.payWith.mercadoPago && <p className="small muted" style={{ margin: 0 }}>Con Mercado Pago puedes pagar con PSE, tarjeta o efectivo. El pago se confirma solo.</p>}
              </>
            )}
          </>
        )}
      </section>

      <section className="card card-flush">
        <div className="card-head"><h2 style={{ margin: 0 }}>Historial de facturas</h2></div>
        {data.invoices.length === 0 ? <Empty title="Aún no hay facturas">La primera factura se emite al terminar la prueba.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>N.º</th><th>Período</th><th className="right">Valor</th><th>Estado</th><th>Pagada</th></tr></thead>
              <tbody>
                {data.invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.number}</td>
                    <td>{date(i.periodStart)} – {date(i.periodEnd)}</td>
                    <td className="right mono">{fmtMoney(i.amountCop)}</td>
                    <td><span className={`badge ${INVOICE_BADGE[i.status] ?? ''}`}>{SAAS_INVOICE_STATUS_LABEL[i.status] ?? i.status}</span></td>
                    <td className="small">{i.paidAt ? `${date(i.paidAt)} · ${SAAS_PAYMENT_METHOD_LABEL[i.paymentMethod] ?? i.paymentMethod}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data.payments.some((p) => p.method === 'transfer') && (
        <section className="card card-flush">
          <div className="card-head"><h2 style={{ margin: 0 }}>Transferencias reportadas</h2></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Fecha</th><th>Referencia</th><th className="right">Valor</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {data.payments.filter((p) => p.method === 'transfer').map((p) => {
                  const [label, cls] = PAYMENT_STATUS[p.status] ?? [p.status, ''];
                  return (
                    <tr key={p.id}>
                      <td>{date(p.paidAt ?? p.createdAt)}</td>
                      <td className="mono">{p.reference}</td>
                      <td className="right mono">{fmtMoney(p.amountCop)}</td>
                      <td><span className={`badge ${cls}`}>{label}</span>{p.rejectReason && <div className="small muted">{p.rejectReason}</div>}</td>
                      <td className="right">{p.hasProof && <button className="btn btn-ghost btn-sm" onClick={() => apiOpen(`/subscription/payments/${p.id}/proof`).catch((e) => setNotice({ kind: 'danger', text: errorText(e) }))}>Ver comprobante</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {open && data.bank && (
        <TransferModal open={transferOpen} onClose={() => setTransferOpen(false)} invoice={open} bank={data.bank}
          onDone={async () => { setTransferOpen(false); setNotice({ kind: 'ok', text: 'Recibimos tu comprobante. Te avisaremos cuando la transferencia quede aprobada.' }); await load(); }} />
      )}
    </div>
  );
}

function TransferModal({ open, onClose, invoice, bank, onDone }: {
  open: boolean; onClose: () => void; invoice: any; bank: NonNullable<Overview['bank']>; onDone: () => void;
}) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const [f, setF] = useState({ reference: '', paidAt: today, notes: '' });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setF({ reference: '', paidAt: today, notes: '' }); setFile(null); setError(''); } }, [open, today]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) { setError('Adjunta el comprobante'); return; }
    setBusy(true);
    setError('');
    try {
      await apiUpload(`/subscription/invoices/${invoice.id}/transfer`, file, 'file', { reference: f.reference, paidAt: f.paidAt, ...(f.notes ? { notes: f.notes } : {}) });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Reportar transferencia · factura N.º ${invoice.number}`}
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancelar</button><button className="btn" type="submit" form="transfer-form" disabled={busy}>{busy ? 'Enviando…' : 'Enviar comprobante'}</button></>}>
      <form id="transfer-form" className="stack" onSubmit={submit}>
        <div className="alert alert-info stack-sm">
          <span>Transfiere <strong>{fmtMoney(invoice.amountCop)}</strong> a:</span>
          <span><strong>{bank.bankName}</strong> · Cuenta de {bank.accountType} <strong className="mono">{bank.accountNumber}</strong></span>
          <span>A nombre de {bank.holder}{bank.holderId ? ` · NIT/CC ${bank.holderId}` : ''}</span>
          {bank.instructions && <span className="small">{bank.instructions}</span>}
        </div>
        <label className="field">Número de referencia o de aprobación<input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} required minLength={3} maxLength={80} autoFocus /></label>
        <label className="field">Fecha de la transferencia<input type="date" value={f.paidAt} max={today} onChange={(e) => setF({ ...f, paidAt: e.target.value })} required /></label>
        <label className="field">Comprobante (imagen PNG o JPG, o PDF; máximo 5 MB)<input type="file" accept="image/png,image/jpeg,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required /></label>
        <label className="field">Notas (opcional)<textarea rows={2} maxLength={500} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
        {error && <div className="alert alert-danger">{error}</div>}
      </form>
    </Modal>
  );
}
