/**
 * NIT colombiano: cálculo del dígito de verificación (DV) según el algoritmo de la DIAN
 * (módulo 11 con pesos primos aplicados de derecha a izquierda).
 */
const WEIGHTS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];

export function nitCheckDigit(nit: string): number {
  const digits = nit.replace(/\D/g, '');
  if (digits.length === 0 || digits.length > WEIGHTS.length) {
    throw new Error('NIT inválido');
  }
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    sum += Number(digits[digits.length - 1 - i]) * WEIGHTS[i];
  }
  const r = sum % 11;
  return r >= 2 ? 11 - r : r;
}

export function isValidNit(nit: string, dv: number): boolean {
  try {
    return nitCheckDigit(nit) === dv;
  } catch {
    return false;
  }
}
