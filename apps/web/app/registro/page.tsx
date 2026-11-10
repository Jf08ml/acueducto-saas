'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { nitCheckDigit, registerOrganizationSchema } from '@agua-mata/shared';
import { api } from '@/lib/api';
import { usePlatformOnly } from '@/lib/host';

const ORG_TYPES = [
  ['asociacion_usuarios', 'Asociación de usuarios'],
  ['comunitario', 'Acueducto comunitario'],
  ['junta_accion_comunal', 'Junta de Acción Comunal'],
  ['empresa_servicios_publicos', 'Empresa de servicios públicos'],
  ['municipio', 'Municipio (prestación directa)'],
  ['otro', 'Otro'],
] as const;

/** Registro de un acueducto nuevo. Luego continúa en /configuracion. */
export default function RegistroPage() {
  const router = useRouter();
  const platformOk = usePlatformOnly();
  const [f, setF] = useState({
    name: '', legalName: '', nit: '', department: '', municipality: '', organizationType: 'asociacion_usuarios',
    estimatedSubscribers: '', contactEmail: '', contactPhone: '', ownerName: '', ownerEmail: '', ownerPassword: '',
  });
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  let dv = '';
  try { if (/^\d{6,15}$/.test(f.nit)) dv = String(nitCheckDigit(f.nit)); } catch { /* NIT incompleto */ }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const payload = {
      name: f.name, legalName: f.legalName, nit: f.nit, nitDv: Number(dv), department: f.department, municipality: f.municipality,
      organizationType: f.organizationType, estimatedSubscribers: Number(f.estimatedSubscribers || 0),
      contactEmail: f.contactEmail, contactPhone: f.contactPhone,
      owner: { fullName: f.ownerName, email: f.ownerEmail, password: f.ownerPassword },
    };
    const parsed = registerOrganizationSchema.safeParse(payload);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Revisa los datos');
    try {
      await api('/onboarding/organizations', { method: 'POST', body: JSON.stringify(parsed.data) });
      await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: f.ownerEmail, password: f.ownerPassword }) });
      router.push('/configuracion');
    } catch (err: any) {
      setError(err.message);
    }
  }

  if (!platformOk) return null;

  return (
    <main className="content" style={{ margin: '0 auto', maxWidth: 820 }}>
      <form className="card stack" onSubmit={submit}>
        <h1 style={{ margin: 0 }}>Registra tu acueducto</h1>
        <p className="muted" style={{ margin: 0 }}>30 días de prueba del plan Profesional, sin tarjeta.</p>
        <h3 style={{ marginTop: 8 }}>Datos de la organización</h3>
        <div className="grid2">
          <label className="field">Nombre del acueducto<input value={f.name} onChange={set('name')} required /></label>
          <label className="field">Razón social<input value={f.legalName} onChange={set('legalName')} required /></label>
          <label className="field">NIT (sin DV)<input value={f.nit} onChange={set('nit')} inputMode="numeric" required /></label>
          <label className="field">Dígito de verificación<input value={dv} readOnly placeholder="Se calcula solo" /></label>
          <label className="field">Departamento<input value={f.department} onChange={set('department')} required /></label>
          <label className="field">Municipio<input value={f.municipality} onChange={set('municipality')} required /></label>
          <label className="field">Tipo de organización
            <select value={f.organizationType} onChange={set('organizationType')}>
              {ORG_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="field">Suscriptores aproximados<input value={f.estimatedSubscribers} onChange={set('estimatedSubscribers')} inputMode="numeric" /></label>
          <label className="field">Correo de contacto<input type="email" value={f.contactEmail} onChange={set('contactEmail')} required /></label>
          <label className="field">Teléfono<input value={f.contactPhone} onChange={set('contactPhone')} required /></label>
        </div>
        <h3 style={{ marginTop: 8 }}>Administrador principal</h3>
        <div className="grid2">
          <label className="field">Nombre completo<input value={f.ownerName} onChange={set('ownerName')} required /></label>
          <label className="field">Correo<input type="email" value={f.ownerEmail} onChange={set('ownerEmail')} required /></label>
          <label className="field">Contraseña (mín. 8)<input type="password" value={f.ownerPassword} onChange={set('ownerPassword')} required /></label>
        </div>
        {error && <div className="alert alert-danger">{error}</div>}
        <button className="btn" type="submit">Crear cuenta y continuar</button>
      </form>
    </main>
  );
}
