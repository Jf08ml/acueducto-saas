'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AREA_TYPES, LEGAL_NATURES, MAX_SUBSIDY_PCT, PROVIDER_TYPES, suggestedBasicConsumptionM3, tariffSchema,
} from '@agua-mata/shared';
import { api, API_URL, apiDownload, apiUpload, waitForJob } from '@/lib/api';
import { useMe } from '@/components/app-shell';
import { PageHeader } from '@/components/ui';
import { ConfirmModal, Modal } from '@/components/modal';

const STEPS = [
  ['profile', 'Perfil regulatorio'],
  ['tariff', 'Tarifa'],
  ['branding', 'Marca'],
  ['collections', 'Cobro'],
  ['domain', 'Dominio'],
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
  const { me, reload: reloadMe } = useMe();
  const [state, setState] = useState<any>(null);
  const [step, setStepState] = useState<Step>('profile');
  const [error, setError] = useState('');

  // Paso inicial desde ?paso=… (sin useSearchParams para no exigir Suspense en build estático).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('paso');
    if (p && STEPS.some(([k]) => k === p)) setStepState(p as Step);
  }, []);
  const setStep = (s: Step) => {
    setStepState(s);
    window.history.replaceState(null, '', `?paso=${s}`);
  };

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
      await reloadMe();
      router.push('/panel');
    } catch (e: any) {
      setError(errMsg(e));
    }
  }

  if (!state) return <>{error ? <p className="alert alert-danger">{error}</p> : <p className="muted">Cargando…</p>}</>;
  const completed = Boolean(state.organization.onboardingCompletedAt);

  return (
    <div className="stack">
      <PageHeader
        title={completed ? 'Configuración' : 'Configuración inicial'}
        description={completed ? 'Ajusta el perfil, la tarifa, la marca y el dominio de tu acueducto.' : 'Completa estos pasos para empezar. Solo el perfil regulatorio y la tarifa son obligatorios.'}
      />

      <div className="tabs" role="tablist" aria-label="Pasos">
        {STEPS.map(([key, label], i) => (
          <button key={key} role="tab" className="tab" aria-selected={step === key} onClick={() => setStep(key)}>
            {i + 1}. {label}
            {key in state.steps && state.steps[key] && <span className="check" aria-label="completo">✓</span>}
          </button>
        ))}
      </div>

      {step === 'profile' && <ProfileStep state={state} onSaved={() => { load(); setStep('tariff'); }} />}
      {step === 'tariff' && <TariffStep state={state} onSaved={() => { load(); setStep('branding'); }} />}
      {step === 'branding' && <BrandingStep state={state} onSaved={() => { load(); reloadMe(); }} />}
      {step === 'collections' && <CollectionsStep />}
      {step === 'domain' && <DomainStep enabled={me.entitlements.features.custom_domain === true} />}
      {step === 'subscribers' && <ImportStep onImported={load} />}
      {step === 'compliance' && <ComplianceStep />}

      {!completed && (
        <section className="card row-between">
          <span className="muted">
            {state.canComplete ? 'Ya puedes empezar a usar AguaMata. Los demás pasos los puedes completar después.' : 'Para empezar necesitas al menos el perfil regulatorio y la tarifa.'}
          </span>
          <button className="btn" onClick={complete} disabled={!state.canComplete}>Finalizar configuración</button>
        </section>
      )}
      {error && <p className="alert alert-danger">{error}</p>}
    </div>
  );
}

function CollectionsStep() {
  const [f, setF] = useState<any>(null);
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);
  useEffect(() => { api('/collections/settings').then((s) => setF(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v])))).catch((e) => setMsg({ kind: 'danger', text: errMsg(e) })); }, []);
  if (!f) return msg ? <p className="alert alert-danger">{msg.text}</p> : <p className="muted">Cargando…</p>;

  const num = (v: string) => Number(String(v).replace(',', '.') || 0);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/collections/settings', {
        method: 'PUT',
        body: JSON.stringify({
          lateInterestEnabled: f.lateInterestEnabled, residentialMonthlyRatePct: num(f.residentialMonthlyRatePct),
          nonResidentialMonthlyRatePct: num(f.nonResidentialMonthlyRatePct), graceDays: Math.round(num(f.graceDays)),
          reconnectionFee: num(f.reconnectionFee), suspensionMinOverdue: Math.round(num(f.suspensionMinOverdue)),
        }),
      });
      setMsg({ kind: 'ok', text: 'Guardado. Aplica desde la próxima facturación.' });
    } catch (err) {
      setMsg({ kind: 'danger', text: errMsg(err) });
    }
  }
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <form className="card stack" onSubmit={save}>
      <h2>Cobro de cartera</h2>
      <p className="muted">Intereses de mora, cargo de reconexión y criterio de suspensión. Los cambios aplican a las facturas que emitas de aquí en adelante.</p>

      <label className="radio-card">
        <input type="checkbox" checked={f.lateInterestEnabled} onChange={(e) => setF({ ...f, lateInterestEnabled: e.target.checked })} />
        <span><strong>Cobrar intereses de mora</strong><br /><span className="muted">Se suman a la siguiente factura, prorrateados por días, sobre el capital vencido. Nunca se cobran intereses sobre intereses.</span></span>
      </label>
      {f.lateInterestEnabled && (
        <div className="grid2">
          <label className="field">Tasa mensual residencial (%)<input inputMode="decimal" value={f.residentialMonthlyRatePct} onChange={set('residentialMonthlyRatePct')} required /></label>
          <label className="field">Tasa mensual no residencial (%)<input inputMode="decimal" value={f.nonResidentialMonthlyRatePct} onChange={set('nonResidentialMonthlyRatePct')} required /></label>
          <label className="field">Días de gracia después del vencimiento<input inputMode="numeric" value={f.graceDays} onChange={set('graceDays')} /></label>
        </div>
      )}
      {f.lateInterestEnabled && (
        <div className="alert alert-info small">
          Orientación: para usuarios residenciales suele aplicarse la tasa de interés civil y para los no residenciales la comercial,
          sin superar la tasa de usura vigente que certifica la Superintendencia Financiera. Confírmalo con tu asesor antes de activarlo.
        </div>
      )}
      <div className="grid2">
        <label className="field">Cargo por reconexión ($)<span className="hint">Se suma a la siguiente factura al reconectar. 0 = sin cargo.</span>
          <input inputMode="numeric" value={f.reconnectionFee} onChange={set('reconnectionFee')} required />
        </label>
        <label className="field">Lista de suspensión desde<span className="hint">Ley 142, art. 140: máximo 3 períodos (mensual) o 2 (bimestral).</span>
          <select value={f.suspensionMinOverdue} onChange={set('suspensionMinOverdue')}>
            {[1, 2, 3].map((n) => <option key={n} value={n}>{n} factura{n > 1 ? 's' : ''} vencida{n > 1 ? 's' : ''}</option>)}
          </select>
        </label>
      </div>
      {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}
      <div><button className="btn" type="submit">Guardar</button></div>
    </form>
  );
}

function DomainStep({ enabled }: { enabled: boolean }) {
  const [data, setData] = useState<any>(null);
  const [hostname, setHostname] = useState('');
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => api('/domains').then(setData).catch((e) => setMsg({ kind: 'danger', text: errMsg(e) })), []);
  useEffect(() => { load(); }, [load]);

  async function act(id: string, action: () => Promise<any>, ok?: (r: any) => string) {
    setBusy(id);
    setMsg(null);
    try {
      const r = await action();
      if (ok) setMsg({ kind: r?.status === 'verified' || !r?.lastError ? 'ok' : 'warn', text: ok(r) });
      await load();
    } catch (e) {
      setMsg({ kind: 'danger', text: errMsg(e) });
    } finally {
      setBusy('');
    }
  }

  const [addOpen, setAddOpen] = useState(false);
  const [addError, setAddError] = useState('');
  const [removing, setRemoving] = useState<any>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setAddError('');
    setBusy('add');
    try {
      await api('/domains', { method: 'POST', body: JSON.stringify({ hostname }) });
      setAddOpen(false);
      setHostname('');
      setMsg({ kind: 'ok', text: 'Dominio agregado. Ahora crea los registros DNS y pulsa Verificar.' });
      await load();
    } catch (err) {
      setAddError(errMsg(err));
    } finally {
      setBusy('');
    }
  }

  if (!data) return <p className="muted">Cargando…</p>;

  return (
    <div className="stack">
      <section className="card stack">
        <h2>Dirección de tu acueducto</h2>
        <p className="muted">Tu acueducto siempre está disponible en el subdominio de la plataforma. Compártelo con tu personal.</p>
        <div className="row">
          <code>{data.defaultUrl}</code>
          <a className="btn btn-secondary btn-sm" href={data.defaultUrl} target="_blank" rel="noreferrer">Abrir</a>
          <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(data.defaultUrl)}>Copiar</button>
        </div>
        {data.primaryUrl !== data.defaultUrl && <p className="small">Dirección principal: <code>{data.primaryUrl}</code></p>}
      </section>

      <section className="card stack">
        <h2>Dominio propio</h2>
        <p className="muted">
          Usa tu propio dominio, por ejemplo <code>portal.miacueducto.org</code>. Crea los dos registros DNS que te indicamos en tu proveedor de dominio
          y luego pulsa <strong>Verificar</strong>. Los cambios de DNS pueden tardar hasta unas horas.
        </p>
        {!enabled ? (
          <div className="alert alert-info">Tu plan no incluye dominios propios.</div>
        ) : (
          <div><button className="btn" onClick={() => { setAddError(''); setAddOpen(true); }}>Agregar dominio propio</button></div>
        )}
        <Modal
          open={addOpen}
          onClose={() => setAddOpen(false)}
          title="Agregar dominio propio"
          footer={<><button className="btn btn-secondary" onClick={() => setAddOpen(false)}>Cancelar</button><button className="btn" type="submit" form="domain-form" disabled={busy === 'add'}>Agregar</button></>}
        >
          <form id="domain-form" className="stack" onSubmit={add}>
            <label className="field">Dominio o subdominio
              <span className="hint">Recomendamos un subdominio, por ejemplo <code>portal.miacueducto.org</code>.</span>
              <input placeholder="portal.miacueducto.org" value={hostname} onChange={(e) => setHostname(e.target.value)} required autoFocus />
            </label>
            <p className="small muted">Después te mostraremos los registros DNS que debes crear en tu proveedor de dominio.</p>
            {addError && <div className="alert alert-danger">{addError}</div>}
          </form>
        </Modal>
        <ConfirmModal
          open={removing !== null}
          onClose={() => setRemoving(null)}
          danger
          title="Quitar dominio"
          confirmLabel="Quitar"
          message={<p>Tu acueducto dejará de responder en <strong>{removing?.hostname}</strong>. Seguirá disponible en <code>{data.defaultUrl}</code>.</p>}
          onConfirm={() => { const d = removing; setRemoving(null); act(d.id, () => api(`/domains/${d.id}`, { method: 'DELETE' })); }}
        />
        {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}

        {data.custom.map((d: any) => (
          <div key={d.id} className="card stack" style={{ background: 'var(--surface-2)' }}>
            <div className="row-between">
              <div className="row">
                <strong>{d.hostname}</strong>
                <span className={`badge ${d.status === 'verified' ? 'badge-ok' : d.status === 'failed' ? 'badge-danger' : 'badge-warn'}`}>
                  {d.status === 'verified' ? 'Verificado' : d.status === 'failed' ? 'No verificado' : 'Pendiente'}
                </span>
                {d.isPrimary && <span className="badge badge-info">Principal</span>}
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn btn-secondary btn-sm" disabled={busy === d.id}
                  onClick={() => act(d.id, () => api(`/domains/${d.id}/verify`, { method: 'POST' }), (r) => (r.status === 'verified' ? '¡Dominio verificado!' : r.lastError))}>
                  Verificar
                </button>
                {d.status === 'verified' && !d.isPrimary && (
                  <button className="btn btn-secondary btn-sm" onClick={() => act(d.id, () => api(`/domains/${d.id}/primary`, { method: 'POST' }))}>Hacer principal</button>
                )}
                <button className="btn btn-ghost btn-sm" onClick={() => setRemoving(d)}>Quitar</button>
              </div>
            </div>
            {d.lastError && d.status !== 'verified' && <p className="small" style={{ color: 'var(--danger)' }}>{d.lastError}</p>}
            <div className="table-wrap">
              <table>
                <thead><tr><th>Tipo</th><th>Nombre</th><th>Valor</th><th>Para qué</th></tr></thead>
                <tbody>
                  {d.dns.map((r: any) => (
                    <tr key={r.type}><td><span className="badge">{r.type}</span></td><td><code>{r.name}</code></td><td><code>{r.value}</code></td><td className="small muted">{r.purpose}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </section>
    </div>
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
        <label className="field">Naturaleza jurídica
          <select value={f.legalNature} onChange={set('legalNature')}>{LEGAL_NATURES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label className="field">Tipo de prestador
          <select value={f.providerType} onChange={set('providerType')}>{PROVIDER_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label className="field">Zona que atiende
          <select value={f.areaType} onChange={set('areaType')}>{AREA_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label className="field">Altitud promedio (m s. n. m.)<input value={f.altitudeMasl} onChange={set('altitudeMasl')} inputMode="numeric" required /></label>
        <label className="field">Número de suscriptores<input value={f.estimatedSubscribers} onChange={set('estimatedSubscribers')} inputMode="numeric" required /></label>
      </div>
      {msg && <p className="alert alert-info">{msg}</p>}
      <button className="btn" type="submit">Guardar y continuar</button>
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
        <label className="field">Nombre<input value={f.name} onChange={set('name')} required /></label>
        <label className="field">Vigente desde<input type="date" value={f.effectiveFrom} onChange={set('effectiveFrom')} required /></label>
        <label className="field">Período de facturación
          <select value={f.billingPeriod} onChange={set('billingPeriod')}>
            <option value="monthly">Mensual</option>
            <option value="bimonthly">Bimestral</option>
          </select>
        </label>
        <label className="field">Consumo básico (m³) · sugerido {suggested}<input value={f.basicConsumptionM3} onChange={set('basicConsumptionM3')} inputMode="numeric" required /></label>
        <label className="field">Cargo fijo ($)<input value={f.fixedCharge} onChange={set('fixedCharge')} inputMode="decimal" required /></label>
        <label className="field">Consumo básico ($/m³)<input value={f.rateBasic} onChange={set('rateBasic')} inputMode="decimal" required /></label>
        <label className="field">Consumo complementario ($/m³)<input value={f.rateComplementary} onChange={set('rateComplementary')} inputMode="decimal" required /></label>
        <label className="field">Consumo suntuario ($/m³)<input value={f.rateSumptuary} onChange={set('rateSumptuary')} inputMode="decimal" required /></label>
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
      {msg && <p className="alert alert-danger">{msg}</p>}
      <button className="btn" type="submit">Guardar tarifa</button>
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
        <label className="field">Color principal<input type="color" value={f.primaryColor} onChange={(e) => setF({ ...f, primaryColor: e.target.value })} /></label>
        <label className="field">Color secundario<input type="color" value={f.secondaryColor} onChange={(e) => setF({ ...f, secondaryColor: e.target.value })} /></label>
      </div>
      <label className="field">Texto al pie del recibo<input value={f.receiptFooter} onChange={(e) => setF({ ...f, receiptFooter: e.target.value })} maxLength={300} /></label>
      <label className="field">Logo (PNG, JPG o WEBP, máx. 1 MB)<input type="file" accept="image/png,image/jpeg,image/webp" onChange={upload} /></label>
      {(b.hasLogo || logoV > 0) && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`${API_URL}/public/orgs/${state.organization.id}/logo?v=${logoV}`} alt="Logo del acueducto" style={{ maxHeight: 80, alignSelf: 'start' }} />
      )}
      <div className="row" style={{ padding: 12, borderRadius: 8, background: f.primaryColor, color: '#fff' }}>
        <strong>{state.organization.name}</strong>
        <span style={{ background: f.secondaryColor, color: '#13232f', padding: '2px 8px', borderRadius: 999 }}>Vista previa</span>
      </div>
      {msg && <p className="alert alert-info">{msg}</p>}
      <button className="btn" type="submit">Guardar marca</button>
    </form>
  );
}

function ImportStep({ onImported }: { onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  async function send(dryRun: boolean) {
    if (!file) return;
    setMsg('');
    setBusy(true);
    try {
      const res = await apiUpload(`/imports/subscribers?dryRun=${dryRun}`, file);
      if (res.jobId) {
        // La importación corre en segundo plano: se muestra el avance hasta que termine.
        setProgress(0);
        const out = await waitForJob<{ imported: number }>(res.jobId, (j) => setProgress(j.progress));
        setResult({ ...res, imported: out.imported });
        onImported();
      } else {
        setResult(res);
      }
    } catch (err) {
      setMsg(errMsg(err));
    } finally {
      setBusy(false);
      setProgress(null);
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
        <button type="button" className="btn btn-secondary" onClick={() => apiDownload('/imports/subscribers/template', 'plantilla-suscriptores.xlsx').catch((e) => setMsg(errMsg(e)))}>
          Descargar plantilla
        </button>
        <input type="file" accept=".xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); }} />
        <button className="btn" type="button" onClick={() => send(true)} disabled={!file || busy}>Revisar archivo</button>
      </div>
      {msg && <p className="alert alert-danger">{msg}</p>}
      {progress !== null && (
        <div className="stack-sm" role="status">
          <span className="small muted">Importando… {progress}%</span>
          <progress max={100} value={progress} style={{ width: '100%' }} />
        </div>
      )}
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
            <button className="btn" type="button" onClick={() => send(false)} disabled={busy}>Importar {result.validRows} suscriptores</button>
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
      {msg && <p className="alert alert-danger">{msg}</p>}
    </section>
  );
}
