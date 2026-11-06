'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { nitCheckDigit, registerOrganizationSchema } from '@agua-mata/shared';
import { api, setToken } from '@/lib/api';

const ORG_TYPES = [
  ['asociacion_usuarios', 'Asociación de usuarios'],
  ['comunitario', 'Acueducto comunitario'],
  ['junta_accion_comunal', 'Junta de Acción Comunal'],
  ['empresa_servicios_publicos', 'Empresa de servicios públicos'],
  ['municipio', 'Municipio (prestación directa)'],
  ['otro', 'Otro'],
] as const;

/** Paso 1 del asistente de onboarding. Los pasos de tarifas, branding e importación Excel vendrán después. */
export default function RegistroPage() {
  const router = useRouter();
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
      const login = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: f.ownerEmail, password: f.ownerPassword }) });
      setToken(login.accessToken);
      router.push('/configuracion');
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <main className="container">
      <form className="card stack" onSubmit={submit} style={{ maxWidth: 720, margin: '0 auto' }}>
        <h1 style={{ margin: 0 }}>Registra tu acueducto</h1>
        <p className="muted" style={{ margin: 0 }}>30 días de prueba del plan Profesional, sin tarjeta.</p>
        <h3>Datos de la organización</h3>
        <div className="grid2">
          <label>Nombre del acueducto<input value={f.name} onChange={set('name')} required /></label>
          <label>Razón social<input value={f.legalName} onChange={set('legalName')} required /></label>
          <label>NIT (sin DV)<input value={f.nit} onChange={set('nit')} inputMode="numeric" required /></label>
          <label>Dígito de verificación<input value={dv} readOnly placeholder="Se calcula solo" /></label>
          <label>Departamento<input value={f.department} onChange={set('department')} required /></label>
          <label>Municipio<input value={f.municipality} onChange={set('municipality')} required /></label>
          <label>Tipo de organización
            <select value={f.organizationType} onChange={set('organizationType')}>
              {ORG_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>Suscriptores aproximados<input value={f.estimatedSubscribers} onChange={set('estimatedSubscribers')} inputMode="numeric" /></label>
          <label>Correo de contacto<input type="email" value={f.contactEmail} onChange={set('contactEmail')} required /></label>
          <label>Teléfono<input value={f.contactPhone} onChange={set('contactPhone')} required /></label>
        </div>
        <h3>Administrador principal</h3>
        <div className="grid2">
          <label>Nombre completo<input value={f.ownerName} onChange={set('ownerName')} required /></label>
          <label>Correo<input type="email" value={f.ownerEmail} onChange={set('ownerEmail')} required /></label>
          <label>Contraseña (mín. 8)<input type="password" value={f.ownerPassword} onChange={set('ownerPassword')} required /></label>
        </div>
        {error && <p className="error">{error}</p>}
        <button type="submit">Crear cuenta</button>
      </form>
    </main>
  );
}
