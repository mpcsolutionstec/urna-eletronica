import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const hmac = (key, value) => createHmac('sha256', key).update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

export function validCpf(input) {
  const cpf = String(input ?? '').replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digit = (length) => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += Number(cpf[i]) * (length + 1 - i);
    const result = (sum * 10) % 11;
    return result === 10 ? 0 : result;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

export function secureEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function requireKeys() {
  for (const name of ['MESARIO_API_KEY', 'INTEGRITY_HMAC_KEY', 'CPF_HMAC_KEY']) {
    if (!process.env[name] || process.env[name].length < 32) {
      throw new Error(`${name} deve ser configurada com pelo menos 32 caracteres.`);
    }
  }
}
