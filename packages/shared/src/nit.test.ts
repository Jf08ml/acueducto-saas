import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nitCheckDigit, isValidNit } from './nit';

test('DV de NIT conocidos', () => {
  assert.equal(nitCheckDigit('800197268'), 4); // DIAN
  assert.equal(nitCheckDigit('899999068'), 1); // Ecopetrol
  assert.equal(nitCheckDigit('860002183'), 9);
});

test('isValidNit rechaza DV incorrecto', () => {
  assert.equal(isValidNit('800197268', 4), true);
  assert.equal(isValidNit('800197268', 5), false);
  assert.equal(isValidNit('abc', 1), false);
});
