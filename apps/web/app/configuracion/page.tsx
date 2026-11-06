'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AREA_TYPES, LEGAL_NATURES, MAX_SUBSIDY_PCT, PROVIDER_TYPES, suggestedBasicConsumptionM3, tariffSchema,
} from '@agua-mata/shared';
import { api, API_URL, apiDownload, apiUpload } from '@/lib/api';

const STEPS = [
  ['profile', 'Perfil regulatorio'],
  ['tariff', 'Tarifa'],
  ['branding', 'Marca'],
  ['subscribers', 'Suscriptores'],
  ['compliance', 'Obligaciones'],
] as const;
type Step = (typeof STEPS)[number][0];

const FACTOR_KEYS = ['1', '2', '3', '4', '5', '6', 'comercial', 'industrial', 'oficial'] as const;
const STATUS_LABEL: Record<string, string> = { pending: 'Pendiente', in_progress: 'En curso', done: 'Cumplida', not_applicable: 'No aplica' };

function errMsg(e: any): string {
  const issue = e?.body?.issues?.[0];
  return issue ? `${issue.path?.join('.') ?? ''}: ${issue.message}` : e?.message ?? 'Error';
}

export default function ConfiguracionPage() {
  const router = useRouter();
  const [state, setState] = useState<any>(null);
  const [step, setStep] = useState<Step>('profile');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setState(await api('/setup/state'));
    } catch (e: any) {
      if (e.status === 401) router.push('/');
      else setError(errMsg(e));
    }
  }, [router]);
  useEffect(() => { load(); }, [load]);

  async function complete() {
    setError('');
    try {
      await api('/setup/complete', { method: 'POST' });
      router.push('/panel');
    } catch (e: any) {
      setError(errMsg(e));
    }
  }

  if (!state) return <main className="container"><p className="muted">Cargando…</p>{error && <p className="error">{error}</p>}</main>;

  return (
    <main className="container stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ margin: 0 }}>Configuración inicial</h1>
          <p className="muted" style={{ margin: 0 }}>{state.organization.name}</p>
        </div>
        <a href="/panel">Ir al panel</a>
      </div>

      <nav className="row" aria-label="Pasos">
        {STEPS.map(([key, label], i) => (
          <button key={key} className={step === key ? '' : 'secondary'} onClick={() => setStep(key)}>
            {i + 1}. {label} {key !== 'compliance' && state.steps[key] ? '✓' : ''}
          </button>
        ))}
      </nav>

      {step === 'profile' && <ProfileStep state={state} onSaved={() => { load(); setStep('tariff'); }} />}
      {step === 'tariff' && <TariffStep state={state} onSaved={() => { load(); setStep('branding'); }} />}
      {step === 'branding' && <BrandingStep state={state} onSaved={load} />}
      {step === 'subscribers' && <ImportStep onImported={load} />}
      {step === 'compliance' && <ComplianceStep />}

      <section className="card row" style={{ justifyContent: 'space-between' }}>
        <span className="muted">
          {state.canComplete ? 'Ya puedes empezar a usar AguaMata. Los demás pasos los puedes completar después.' : 'Para empezar necesitas al menos el perfil regulatorio y la tarifa.'}
        </span>
        <button onClick={complete} disabled={!state.canComplete}>Finalizar configuración</button>
      </section>
      {error && <p className="error">{error}</p>}
    </main>
  );
}

function ProfileStep({ state, onSaved }: { state: any; onSaved: () => void }) {
  const o = state.organization;
  const [f, setF] = useState({
    legalNature: o.legalNature ?? 'sin_animo_lucro',
    providerType: o.providerType ?? 'organizacion_autorizada',
    areaType: o.areaType ?? 'rural',
    altitudeMasl: String(o.altitudeMasl ?? ''),
    estimatedSubscribers: String(o.estimatedSubscribers ?? 0),
  });
  const [msg, setMsg] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    try {
      const res = await api('/setup/profile', {
        method: 'PUT',
        body: JSON.stringify({ ...f, altitudeMasl: Number(f.altitudeMasl), estimatedSubscribers: Number(f.estimatedSubscribers) }),
      });
      setMsg(`Guardado. Se identificaron ${res.compliance.total} obligaciones para tu acueducto.`);
      onSaved();
    } catch (err) {
      setMsg(errMsg(err));
    }
  }

  return (
    <form className="card stack" onSubmit={save}>
      <h2 style={{ margin: 0 }}>Perfil jurídico y regulatorio</h2>
      <p className="muted" style={{ margin: 0 }}>Con esto identificamos las obligaciones y la metodología tarifaria que te aplican.</p>
      <div className="grid2">
        <label>Naturaleza jurídica
          <select value={f.legalNature} onChange={set('legalNature')}>{LEGAL_NATURES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label>Tipo de prestador
          <select value={f.providerType} onChange={set('providerType')}>{PROVIDER_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label>Zona que atiende
          <select value={f.areaType} onChange={set('areaType')}>{AREA_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label>Altitud promedio (m s. n. m.)<input value={f.altitudeMasl} onChange={set('altitudeMasl')} inputMode="numeric" required /></label>
        <label>Número de suscriptores<input value={f.estimatedSubscribers} onChange={set('estimatedSubscribers')} inputMode="numeric" required /></label>
      </div>
      {msg && <p className="muted">{msg}</p>}
      <button type="submit">Guardar y continuar</button>
    </form>
  );
}

function TariffStep({ state, onSaved }: { state: any; onSaved: () => void }) {
  const t = state.tariff;
  const suggested = state.suggestedBasicConsumptionM3 ?? (state.organization.altitudeMasl != null ? suggestedBasicConsumptionM3(state.organization.altitudeMasl) : 13);
  const [f, setF] = useState({
    name: t?.name ?? `Tarifa ${new Date().getFullYear()}`,
    effectiveFrom: t?.effectiveFrom?.slice(0, 10) ?? `${new Date().getFullYear()}-01-01`,
    billingPeriod: t?.billingPeriod ?? 'monthly',
    basicConsumptionM3: String(t?.basicConsumptionM3 ?? suggested),
    fixedCharge: String(t?.fixedCharge ?? ''),
    rateBasic: String(t?.rateBasic ?? ''),
    rateComplementary: String(t?.rateComplementary ?? ''),
    rateSumptuary: String(t?.rateSumptuary ?? ''),
  });
  const [factors, setFactors] = useState<Record<string, string>>(
    Object.fromEntries(FACTOR_KEYS.map((k) => [k, String(t?.stratumFactors?.[k] ?? 0)])),
  );
  const [msg, setMsg] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    const payload = {
      ...f,
      basicConsumptionM3: Number(f.basicConsumptionM3),
      fixedCharge: Number(f.fixedCharge), rateBasic: Number(f.rateBasic),
      rateComplementary: Number(f.rateComplementary), rateSumptuary: Number(f.rateSumptuary),
      stratumFactors: Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, Number(v || 0)])),
    };
    const parsed = tariffSchema.safeParse(payload);
    if (!parsed.success) return setMsg(`${parsed.error.issues[0].path.join('.')}: ${parsed.error.issues[0].message}`);
    try {
      await api('/setup/tariff', { method: 'PUT', body: JSON.stringify(parsed.data) });
      onSaved();
    } catch (err) {
      setMsg(errMsg(err));
    }
  }

  return (
    <form className="card stack" onSubmit={save}>
      <h2 style={{ margin: 0 }}>Tarifa del servicio de acueducto</h2>
      <p className="muted" style={{ margin: 0 }}>
        Valores en pesos según tu estudio de costos. Guardar una tarifa nueva conserva la anterior como historial.
      </p>
      <div className="grid2">
        <label>Nombre<input value={f.name} onChange={set('name')} required /></label>
        <label>Vigente desde<input type="date" value={f.effectiveFrom} onChange={set('effectiveFrom')} required /></label>
        <label>Período de facturación
          <select value={f.billingPeriod} onChange={set('billingPeriod')}>
            <option value="monthly">Mensual</option>
            <option value="bimonthly">Bimestral</option>
          </select>
        </label>
        <label>Consumo básico (m³) · sugerido {suggested}<input value={f.basicConsumptionM3} onChange={set('basicConsumptionM3')} inputMode="numeric" required /></label>
        <label>Cargo fijo ($)<input value={f.fixedCharge} onChange={set('fixedCharge')} inputMode="decimal" required /></label>
        <label>Consumo básico ($/m³)<input value={f.rateBasic} onChange={set('rateBasic')} inputMode="decimal" required /></label>
        <label>Consumo complementario ($/m³)<input value={f.rateComplementary} onChange={set('rateComplementary')} inputMode="decimal" required /></label>
        <label>Consumo suntuario ($/m³)<input value={f.rateSumptuary} onChange={set('rateSumptuary')} inputMode="decimal" required /></label>
      </div>
      <h3 style={{ marginBottom: 0 }}>Subsidios y contribuciones (%)</h3>
      <p className="muted" style={{ margin: 0 }}>
        Negativo = subsidio, positivo = contribución. Topes de subsidio: estrato 1 hasta {MAX_SUBSIDY_PCT['1']}%, estrato 2 hasta {MAX_SUBSIDY_PCT['2']}%,
        estrato 3 hasta {MAX_SUBSIDY_PCT['3']}%. El estrato 4 paga el costo de referencia.
      </p>
      <div className="grid2">
        {FACTOR_KEYS.map((k) => (
          <label key={k}>{/^\d$/.test(k) ? `Estrato ${k}` : k[0].toUpperCase() + k.slice(1)}
            <input value={factors[k]} onChange={(e) => setFactors({ ...factors, [k]: e.target.value })} inputMode="numeric" disabled={k === '4'} />
          </label>
        ))}
      </div>
      {msg && <p className="error">{msg}</p>}
      <button type="submit">Guardar tarifa</button>
    </form>
  );
}

function BrandingStep({ state, onSaved }: { state: any; onSaved: () => void }) {
  const b = state.organization.branding;
  const [f, setF] = useState({ primaryColor: b.primaryColor ?? '#0b6e99', secondaryColor: b.secondaryColor ?? '#f2a900', receiptFooter: b.receiptFooter ?? '' });
  const [msg, setMsg] = useState('');
  const [logoV, setLogoV] = useState(0);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    try {
      await api('/setup/branding', { method: 'PUT', body: JSON.stringify(f) });
      setMsg('Guardado.');
      onSaved();
    } catch (err) {
      setMsg(errMsg(err));
    }
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setMsg('');
    try {
      await apiUpload('/setup/branding/logo', file);
      setLogoV(Date.now());
      onSaved();
    } catch (err) {
      setMsg(errMsg(err));
    }
  }

  return (
    <form className="card stack" onSubmit={save}>
      <h2 style={{ margin: 0 }}>Marca del acueducto</h2>
      <p className="muted" style={{ margin: 0 }}>Se usa en el panel y en los recibos. No afecta a ninguna otra organización.</p>
      <div className="grid2">
        <label>Color principal<input type="color" value={f.primaryColor} onChange={(e) => setF({ ...f, primaryColor: e.target.value })} /></label>
        <label>Color secundario<input type="color" value={f.secondaryColor} onChange={(e) => setF({ ...f, secondaryColor: e.target.value })} /></label>
      </div>
      <label>Texto al pie del recibo<input value={f.receiptFooter} onChange={(e) => setF({ ...f, receiptFooter: e.target.value })} maxLength={300} /></label>
      <label>Logo (PNG, JPG o WEBP, máx. 1 MB)<input type="file" accept="image/png,image/jpeg,image/webp" onChange={upload} /></label>
      {(b.hasLogo || logoV > 0) && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`${API_URL}/public/orgs/${state.organization.id}/logo?v=${logoV}`} alt="Logo del acueducto" style={{ maxHeight: 80, alignSelf: 'start' }} />
      )}
      <div className="row" style={{ padding: 12, borderRadius: 8, background: f.primaryColor, color: '#fff' }}>
        <strong>{state.organization.name}</strong>
        <span style={{ background: f.secondaryColor, color: '#13232f', padding: '2px 8px', borderRadius: 999 }}>Vista previa</span>
      </div>
      {msg && <p className="muted">{msg}</p>}
      <button type="submit">Guardar marca</button>
    </form>
  );
}

function ImportStep({ onImported }: { onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(dryRun: boolean) {
    if (!file) return;
    setMsg('');
    setBusy(true);
    try {
      const res = await apiUpload(`/imports/subscribers?dryRun=${dryRun}`, file);
      setResult(res);
      if (!dryRun && res.imported > 0) onImported();
    } catch (err) {
      setMsg(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <h2 style={{ margin: 0 }}>Importar suscriptores desde Excel</h2>
      <p className="muted" style={{ margin: 0 }}>
        Descarga la plantilla, llénala y súbela. Primero la revisamos; si no hay errores, confirmas la importación.
        Si hay un solo error no se importa nada, para que no queden datos a medias.
      </p>
      <div className="row">
        <button type="button" className="secondary" onClick={() => apiDownload('/imports/subscribers/template', 'plantilla-suscriptores.xlsx').catch((e) => setMsg(errMsg(e)))}>
          Descargar plantilla
        </button>
        <input type="file" accept=".xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); }} />
        <button type="button" onClick={() => send(true)} disabled={!file || busy}>Revisar archivo</button>
      </div>
      {msg && <p className="error">{msg}</p>}
      {result && (
        <div className="stack">
          <p style={{ margin: 0 }}>
            {result.imported > 0
              ? `Se importaron ${result.imported} suscriptores.`
              : `${result.totalRows} filas · ${result.validRows} válidas · ${result.issueCount} errores`}
          </p>
          {result.issueCount > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Fila</th><th>Campo</th><th>Problema</th></tr></thead>
                <tbody>
                  {result.issues.map((i: any, n: number) => (
                    <tr key={n}><td>{i.row || '—'}</td><td>{i.field ?? ''}</td><td>{i.message}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.dryRun && result.issueCount === 0 && result.validRows > 0 && (
            <button type="button" onClick={() => send(false)} disabled={busy}>Importar {result.validRows} suscriptores</button>
          )}
        </div>
      )}
    </section>
  );
}

function ComplianceStep() {
  const [items, setItems] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => api('/compliance').then(setItems).catch((e) => setMsg(errMsg(e))), []);
  useEffect(() => { load(); }, [load]);

  async function update(code: string, status: string) {
    try {
      await api(`/compliance/${code}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      load();
    } catch (e) {
      setMsg(errMsg(e));
    }
  }

  return (
    <section className="card stack">
      <h2 style={{ margin: 0 }}>Obligaciones de tu acueducto</h2>
      <p className="muted" style={{ margin: 0 }}>
        Lista orientativa generada a partir de tu perfil. Valídala con tu asesor jurídico o con la autoridad competente.
      </p>
      {items.length === 0 && <p className="muted">Completa el perfil regulatorio para generar la lista.</p>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Obligación</th><th>Entidad</th><th>Norma</th><th>Periodicidad</th><th>Estado</th></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td><strong>{i.obligation?.title}</strong><br /><span className="muted">{i.obligation?.description}</span></td>
                <td>{i.obligation?.authority}</td>
                <td>{i.obligation?.legalBasis}</td>
                <td>{i.obligation?.frequency}</td>
                <td>
                  <select value={i.status} onChange={(e) => update(i.obligationCode, e.target.value)}>
                    {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {msg && <p className="error">{msg}</p>}
    </section>
  );
}
