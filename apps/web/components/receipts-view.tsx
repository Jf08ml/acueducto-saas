'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Receipt, type Issuer } from './receipt';
import { errorText, Icon } from './ui';

/** Muestra uno o varios recibos con botón de impresión. `source` arma la ruta de la API desde la URL. */
export function ReceiptsView({ source }: { source: (q: URLSearchParams) => string | null }) {
  const [data, setData] = useState<{ issuer: Issuer; invoices: any[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const path = source(new URLSearchParams(window.location.search));
    if (!path) { setError('Falta el recibo o el período'); return; }
    api(path).then(setData).catch((e) => setError(errorText(e)));
  }, [source]);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!data) return <p className="muted">Cargando…</p>;

  return (
    <div className="stack">
      <div className="row-between no-print">
        <a className="btn btn-ghost" href={data.invoices[0] ? `/facturacion/periodo?p=${data.invoices[0].period}` : '/facturacion'}>← Volver</a>
        <div className="row">
          <span className="muted small">{data.invoices.length} recibo(s). Usa «Guardar como PDF» en el diálogo de impresión.</span>
          <button className="btn" onClick={() => window.print()}><Icon name="printer" /> Imprimir</button>
        </div>
      </div>
      {data.invoices.length === 0 && <div className="alert alert-info">No hay recibos vigentes para este período.</div>}
      {data.invoices.map((inv) => <Receipt key={inv.id} issuer={data.issuer} invoice={inv} />)}
    </div>
  );
}
