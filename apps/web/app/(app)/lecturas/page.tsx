'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { currentPeriod, READING_OBSERVATIONS } from '@agua-mata/shared';
import { api } from '@/lib/api';
import { useMe } from '@/components/app-shell';
import { AnomalyBadge, Empty, fmtNumber, PageHeader, Stat } from '@/components/ui';

interface Row {
  meterId: string;
  serial: string;
  subscriber: { code: string; fullName: string; address: string };
  previousValue: number;
  averageM3: number | null;
  reading: null | { value: number | null; consumptionM3: number; isEstimated: boolean; anomaly: string | null; observation: string | null; locked: boolean };
}
type Draft = { value: string; observation: string };

function lastPeriods(n: number) {
  const out: string[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < n; i++) {
    out.push(currentPeriod(d));
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

export default function LecturasPage() {
  const { me } = useMe();
  const [period, setPeriod] = useState(currentPeriod());
  const [readingDate, setReadingDate] = useState(new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<Row[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [filter, setFilter] = useState<'all' | 'pending' | 'review'>('all');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const canEdit = me.role !== 'reader';

  const load = useCallback(async () => {
    try {
      const data = await api<Row[]>(`/readings/sheet?period=${period}`);
      setRows(data);
      setDrafts({});
      setRowErrors({});
    } catch (e: any) {
      setMsg({ kind: 'danger', text: e.message });
    }
  }, [period]);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => rows.filter((r) => {
    if (filter === 'pending') return !r.reading;
    if (filter === 'review') return r.reading && r.reading.anomaly && r.reading.anomaly !== 'estimated';
    return true;
  }), [rows, filter]);

  const done = rows.filter((r) => r.reading).length;
  const review = rows.filter((r) => r.reading?.anomaly && r.reading.anomaly !== 'estimated').length;
  const dirty = Object.entries(drafts).filter(([, d]) => d.value !== '' || d.observation !== '');

  function draftOf(r: Row): Draft {
    return drafts[r.meterId] ?? { value: r.reading?.value != null ? String(r.reading.value) : '', observation: r.reading?.observation ?? '' };
  }
  function setDraft(id: string, patch: Partial<Draft>, r: Row) {
    setDrafts({ ...drafts, [id]: { ...draftOf(r), ...patch } });
  }

  async function save() {
    setMsg(null);
    setSaving(true);
    try {
      const entries = dirty.map(([meterId, d]) => ({
        meterId,
        value: d.value === '' ? null : Number(d.value.replace(',', '.')),
        observation: d.observation || null,
      }));
      const bad = entries.find((e) => e.value === null && !e.observation);
      if (bad) {
        setRowErrors({ [bad.meterId]: 'Sin lectura: indica la causal' });
        setMsg({ kind: 'danger', text: 'Hay lecturas vacías sin causal.' });
        return;
      }
      const res = await api('/readings', { method: 'POST', body: JSON.stringify({ period, readingDate, entries }) });
      const errs: Record<string, string> = {};
      for (const r of res.results) if (!r.ok) errs[r.meterId] = r.error;
      await load();
      setRowErrors(errs);
      setMsg(res.failed
        ? { kind: 'danger', text: `${res.saved} guardadas, ${res.failed} con error (revisa las filas marcadas).` }
        : { kind: 'ok', text: `${res.saved} lecturas guardadas.` });
    } catch (e: any) {
      setMsg({ kind: 'danger', text: e.body?.issues?.[0]?.message ?? e.message });
    } finally {
      setSaving(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>, i: number) {
    if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); inputs.current[i + 1]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); inputs.current[i - 1]?.focus(); }
  }

  return (
    <>
      <PageHeader
        title="Lecturas"
        description="Digita la ruta de lectura. Enter pasa al siguiente medidor. Si no se pudo leer, deja el valor vacío y elige la causal: el consumo se estima por promedio."
        actions={canEdit && <button className="btn" onClick={save} disabled={!dirty.length || saving}>{saving ? 'Guardando…' : `Guardar ${dirty.length || ''}`}</button>}
      />

      <div className="grid-stats" style={{ marginBottom: 16 }}>
        <Stat label="Avance" value={`${fmtNumber(done)} / ${fmtNumber(rows.length)}`} progress={rows.length ? done / rows.length : 0} />
        <Stat label="Pendientes" value={fmtNumber(rows.length - done)} />
        <Stat label="Para revisar" value={fmtNumber(review)} sub="Consumo alto, lectura menor o sin consumo" />
      </div>

      <section className="card card-flush">
        <div className="card-head">
          <div className="row">
            <label className="field" style={{ minWidth: 140 }}>Período
              <select value={period} onChange={(e) => setPeriod(e.target.value)}>
                {lastPeriods(12).map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className="field" style={{ minWidth: 160 }}>Fecha de lectura
              <input type="date" value={readingDate} onChange={(e) => setReadingDate(e.target.value)} />
            </label>
          </div>
          <div className="tabs" role="tablist" style={{ border: 0 }}>
            {([['all', 'Todos'], ['pending', 'Pendientes'], ['review', 'Para revisar']] as const).map(([v, l]) => (
              <button key={v} role="tab" className="tab" aria-selected={filter === v} onClick={() => setFilter(v)}>{l}</button>
            ))}
          </div>
        </div>
        {msg && <div className={`alert alert-${msg.kind}`} style={{ margin: 16 }}>{msg.text}</div>}

        {shown.length === 0 ? (
          <Empty title={rows.length ? 'Nada en esta vista' : 'No hay medidores activos'}>
            {!rows.length && <a href="/medidores">Instala los medidores de tus suscriptores</a>}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Suscriptor</th><th>Medidor</th><th className="right">Anterior</th><th style={{ width: 130 }}>Lectura actual</th>
                  <th style={{ width: 190 }}>Causal / observación</th><th className="right">Consumo m³</th><th className="right">Promedio</th><th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => {
                  const d = draftOf(r);
                  const isDirty = Boolean(drafts[r.meterId]);
                  const val = d.value === '' ? null : Number(d.value.replace(',', '.'));
                  const preview = isDirty
                    ? val === null ? (d.observation ? 'Estimado' : '—') : fmtNumber(Math.max(val - r.previousValue, 0), 2)
                    : r.reading ? fmtNumber(r.reading.consumptionM3, 2) : '—';
                  const locked = r.reading?.locked || !canEdit;
                  return (
                    <tr key={r.meterId} style={rowErrors[r.meterId] ? { background: 'var(--danger-bg)' } : undefined}>
                      <td><span className="mono">{r.subscriber.code}</span> · {r.subscriber.fullName}<div className="small muted">{r.subscriber.address}</div></td>
                      <td className="mono small">{r.serial}</td>
                      <td className="right mono">{fmtNumber(r.previousValue, 2)}</td>
                      <td>
                        <input
                          ref={(el) => { inputs.current[i] = el; }}
                          inputMode="decimal" value={d.value} disabled={locked} aria-label={`Lectura de ${r.subscriber.code}`}
                          onChange={(e) => setDraft(r.meterId, { value: e.target.value }, r)} onKeyDown={(e) => onKey(e, i)}
                        />
                      </td>
                      <td>
                        <select value={d.observation} disabled={locked} onChange={(e) => setDraft(r.meterId, { observation: e.target.value }, r)} aria-label="Causal">
                          <option value="">—</option>
                          {READING_OBSERVATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </td>
                      <td className="right mono">{preview}</td>
                      <td className="right mono muted">{r.averageM3 !== null ? fmtNumber(r.averageM3, 1) : '—'}</td>
                      <td>
                        {rowErrors[r.meterId]
                          ? <span className="badge badge-danger">{rowErrors[r.meterId]}</span>
                          : isDirty ? <span className="badge">Sin guardar</span>
                          : r.reading ? <AnomalyBadge anomaly={r.reading.anomaly} />
                          : <span className="badge">Pendiente</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
