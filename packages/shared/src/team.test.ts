import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAssignRole, canManageMember, inviteSchema } from './team';

test('reglas de gestión de miembros', () => {
  assert.equal(canManageMember('owner', 'owner', false), true);
  assert.equal(canManageMember('owner', 'admin', true), false); // nadie se gestiona a sí mismo
  assert.equal(canManageMember('admin', 'owner', false), false);
  assert.equal(canManageMember('admin', 'operator', false), true);
  assert.equal(canManageMember('operator', 'reader', false), false);
  assert.equal(canAssignRole('admin', 'owner'), false);
  assert.equal(canAssignRole('admin', 'admin'), true);
});

test('el correo de la invitación se normaliza', () => {
  assert.equal(inviteSchema.parse({ email: '  Ana@Correo.CO ', role: 'reader' }).email, 'ana@correo.co');
});
