'use client';

import { useCallback, useEffect, useState } from 'react';
import { AUDIT_ACTION_LABEL, AUDIT_CATEGORIES } from '@agua-mata/shared';
import { api } from '@/lib/api';
import { Empty, errorText } from './ui';

const when = (d: string) => new Date(d).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'medium', timeStyle: 'short' });

/** Resumen corto de los datos de una entrada (sin volcar JSON crudo). */
function detail(e: any): string {
  const d = e.data ?? {};
  if (e.action === 'support.request') return `${d.method ?? ''} ${d.path ?? ''}`.trim();
  const parts: string[] = [];
  for (const k of ['reason', 'note', 'email', 'role', 'period', 'count', 'reference', 'method', 'scope', 'durationHours', 'number']) {
    if (d[k] !== undefined && d[k] !== null && typeof d[k] !== 'object') parts.push(String(d[k]));
  }
  if (d.viaSupportGrant) parts.push('durante una sesión de soporte');
  return parts.join(' · ');
}

/** Bitácora paginada con filtro por categoría. `path` es /audit (acueducto) o /platform/audit (superadmin). */
export function AuditLog({ path, showOrganization = false, categories = AUDIT_CATEGORIES }: { path: string; showOrganization?: boolean; categories?: typeof AUDIT_CATEGORIES }) {
  const [category, setCategory] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (before?: string) => {
    setLoading(true);
    setError('');
    try {
      const q = new URLSearchParams({ limit: '50', ...(category ? { category } : {}), ...(before ? { before } : {}) });
      const res = await api<{ items: any[]; nextBefore: string | null }>(`${path}?${q}`);
      setItems((prev) => (before ? [...prev, ...res.items] : res.items));
      setNext(res.nextBefore);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [category, path]);
  useEffect(() => { load(); }, [load]);

  return (
    <section className="card card-flush">
      <div className="card-head">
        <h2 style={{ margin: 0 }}>Bitácora</h2>
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ maxWidth: 260 }} aria-label="Filtrar por tipo">
          <option value="">Todas las acciones</option>
          {categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
      </div>
      {error && <div className="alert alert-danger" style={{ margin: 16 }}>{error}</div>}
      {items.length === 0 && !loading ? <Empty title="Sin registros" /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Fecha</th>{showOrganization && <th>Acueducto</th>}<th>Quién</th><th>Acción</th><th>Detalle</th></tr></thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>{when(e.occurredAt)}</td>
                  {showOrganization && <td className="small">{e.organization?.name ?? '—'}</td>}
                  <td className="small">
                    {e.actor ? <>{e.actor.name}{e.actor.isSupport && <> <span className="badge badge-info">Soporte AguaMata</span></>}</> : <span className="muted">Sistema</span>}
                  </td>
                  <td>{AUDIT_ACTION_LABEL[e.action] ?? e.action}</td>
                  <td className="small muted">{detail(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <div style={{ padding: 16 }}>
          <button className="btn btn-secondary" disabled={loading} onClick={() => load(next)}>{loading ? 'Cargando…' : 'Ver más'}</button>
        </div>
      )}
    </section>
  );
}
