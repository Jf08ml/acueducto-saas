'use client';

import { useEffect, useState } from 'react';
import { api, apiDownload, waitForJob } from '@/lib/api';
import { Receipt, type Issuer } from './receipt';
import { errorText, Icon } from './ui';

/**
 * Muestra uno o varios recibos con botones de impresión y PDF. `source` arma la ruta de la API desde la URL.
 * El PDF lo genera el servidor: uno solo se descarga al instante; los de un período se generan en segundo plano.
 */
export function ReceiptsView({ source }: { source: (q: URLSearchParams) => string | null }) {
  const [data, setData] = useState<{ issuer: Issuer; invoices: any[] } | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pdf, setPdf] = useState<{ busy: boolean; progress: number | null; error: string }>({ busy: false, progress: null, error: '' });

  useEffect(() => {
    const p = source(new URLSearchParams(window.location.search));
    setPath(p);
    if (!p) { setError('Falta el recibo o el período'); return; }
    api(p).then(setData).catch((e) => setError(errorText(e)));
  }, [source]);

  async function downloadPdf() {
    if (!path || !data) return;
    setPdf({ busy: true, progress: null, error: '' });
    try {
      if (path.startsWith('/invoices/')) {
        const inv = data.invoices[0];
        await apiDownload(`${path}/pdf`, `recibo-${inv.period}-${inv.number}.pdf`);
      } else {
        const job = await api<{ id: string }>(`${path}/pdf`, { method: 'POST' });
        setPdf({ busy: true, progress: 0, error: '' });
        await waitForJob(job.id, (j) => setPdf({ busy: true, progress: j.progress, error: '' }));
        await apiDownload(`/jobs/${job.id}/file`, `recibos-${data.invoices[0]?.period ?? 'periodo'}.pdf`);
      }
      setPdf({ busy: false, progress: null, error: '' });
    } catch (e) {
      setPdf({ busy: false, progress: null, error: errorText(e) });
    }
  }

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!data) return <p className="muted">Cargando…</p>;

  return (
    <div className="stack">
      <div className="row-between no-print">
        <a className="btn btn-ghost" href={data.invoices[0] ? `/facturacion/periodo?p=${data.invoices[0].period}` : '/facturacion'}>← Volver</a>
        <div className="row">
          <span className="muted small">{data.invoices.length} recibo(s)</span>
          {data.invoices.length > 0 && (
            <button className="btn btn-secondary" onClick={downloadPdf} disabled={pdf.busy}>
              <Icon name="receipt" /> {pdf.busy ? (pdf.progress !== null ? `Generando PDF… ${pdf.progress}%` : 'Generando PDF…') : 'Descargar PDF'}
            </button>
          )}
          <button className="btn" onClick={() => window.print()}><Icon name="printer" /> Imprimir</button>
        </div>
      </div>
      {pdf.error && <div className="alert alert-danger no-print">{pdf.error}</div>}
      {data.invoices.length === 0 && <div className="alert alert-info">No hay recibos vigentes para este período.</div>}
      {data.invoices.map((inv) => <Receipt key={inv.id} issuer={data.issuer} invoice={inv} />)}
    </div>
  );
}
