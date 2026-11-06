import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHost, isValidHostname, normalizeHostname, tenantDefaultUrl } from './domains';
import { computeConsumption } from './readings';

test('clasifica hosts de plataforma, subdominio y dominio propio', () => {
  assert.deepEqual(classifyHost('aguamata.co', 'aguamata.co'), { kind: 'platform' });
  assert.deepEqual(classifyHost('www.aguamata.co', 'aguamata.co'), { kind: 'platform' });
  assert.deepEqual(classifyHost('el-encano.aguamata.co', 'aguamata.co'), { kind: 'subdomain', slug: 'el-encano' });
  assert.deepEqual(classifyHost('admin.aguamata.co', 'aguamata.co'), { kind: 'platform' });
  assert.deepEqual(classifyHost('el-encano.localhost:3000', 'localhost'), { kind: 'subdomain', slug: 'el-encano' });
  assert.deepEqual(classifyHost('Portal.AcueductoX.org', 'aguamata.co'), { kind: 'custom', hostname: 'portal.acueductox.org' });
});

test('normaliza y valida nombres de host', () => {
  assert.equal(normalizeHostname('https://Portal.Ejemplo.org/login'), 'portal.ejemplo.org');
  assert.equal(isValidHostname('portal.ejemplo.org'), true);
  assert.equal(isValidHostname('localhost'), false);
  assert.equal(isValidHostname('-malo.org'), false);
  assert.equal(tenantDefaultUrl('http://localhost:3000', 'x'), 'http://x.localhost:3000');
});

test('consumo: normal, negativo, cero, alto y estimado', () => {
  assert.deepEqual(computeConsumption(100, 115, []), { consumption: 15, isEstimated: false, anomaly: null });
  assert.equal(computeConsumption(100, 90, []).anomaly, 'negative');
  assert.equal(computeConsumption(100, 90, []).consumption, 0);
  assert.equal(computeConsumption(100, 100, []).anomaly, 'zero');
  assert.equal(computeConsumption(100, 150, [12, 14, 13]).anomaly, 'high');
  assert.deepEqual(computeConsumption(100, null, [12, 14, 13]), { consumption: 13, isEstimated: true, anomaly: 'estimated' });
});
