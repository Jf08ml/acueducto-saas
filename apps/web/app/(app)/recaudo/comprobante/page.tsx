'use client';

import { useEffect, useState } from 'react';
import { PAYMENT_METHODS } from '@agua-mata/shared';
import { api, API_URL } from '@/lib/api';
import { brandStyle, errorText, fmtMoney, Icon } from '@/components/ui';

const METHOD = Object.fromEntries(PAYMENT_METHODS) as Record<string, string>;

/** Comprobante de pago imprimible. */
export default function ComprobantePage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) { setError('Falta el comprobante'); return; }
    api(`/payments/${id}`).then(setData).catch((e) => setError(errorText(e)));
  }, []);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!data) return <p className="muted">Cargando…</p>;
  const { issuer, payment: p } = data;

  return (
    <div className="stack">
      <div className="row-between no-print">
        <a className="btn btn-ghost" href="/recaudo">← Recaudo</a>
        <button className="btn" onClick={() => window.print()}><Icon name="printer" /> Imprimir</button>
      </div>
      <article className={`receipt ${p.status === 'void' ? 'void' : ''}`} style={{ ...brandStyle(issuer.branding.primaryColor), maxWidth: 560 }}>
        <header className="r-head">
          <div className="row" style={{ alignItems: 'flex-start' }}>
            {issuer.branding.hasLogo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="r-logo" src={`${API_URL}/public/orgs/${issuer.id}/logo`} alt="" />
            )}
            <div>
              <h1>{issuer.name}</h1>
              <div>NIT {issuer.nit} · {issuer.municipality}</div>
            </div>
          </div>
          <div className="r-num"><span className="r-label">Comprobante de pago</span><strong>N.º {p.number}</strong><span>{p.paidAt}</span></div>
        </header>
        <section className="r-grid">
          <div><div className="r-label">Recibido de</div><strong>{p.subscriber.fullName}</strong><div>Código {p.subscriber.code} · Doc. {p.subscriber.documentNumber}</div></div>
          <div><div className="r-label">Medio de pago</div><div>{METHOD[p.method] ?? p.method}{p.reference ? ` · Ref. ${p.reference}` : ''}</div></div>
        </section>
        <table>
          <thead><tr><th>Factura</th><th>Período</th><th className="right">Abonado</th></tr></thead>
          <tbody>
            {p.allocations.map((a: any) => (
              <tr key={a.invoiceNumber}><td className="mono">N.º {a.invoiceNumber}</td><td>{a.period}</td><td className="right mono">{fmtMoney(a.amount)}</td></tr>
            ))}
          </tbody>
        </table>
        <div className="r-total"><span>Valor recibido</span><strong>{fmtMoney(p.amount)}</strong></div>
        <footer className="r-foot">
          {p.status === 'void' && <p style={{ color: '#b42318' }}>Comprobante anulado: {p.voidReason}</p>}
          {p.notes && <p>{p.notes}</p>}
          <p>Saldo pendiente a la fecha: {fmtMoney(data.balanceNow)}</p>
          {issuer.branding.receiptFooter && <p>{issuer.branding.receiptFooter}</p>}
        </footer>
      </article>
    </div>
  );
}
