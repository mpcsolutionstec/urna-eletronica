import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

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

export function validPasswordHash(storedHash) {
  if (typeof storedHash !== 'string') return false;
  const [salt, encoded] = storedHash.split(':');
  if (!salt || !encoded || storedHash.split(':').length !== 2) return false;
  try {
    const expected = Buffer.from(encoded, 'base64url');
    return expected.length >= 32;
  } catch { return false; }
}

export function passwordMatches(password, storedHash) {
  if (!validPasswordHash(storedHash)) return false;
  const [salt, encoded] = storedHash.split(':');
  try {
    const expected = Buffer.from(encoded, 'base64url');
    const actual = scryptSync(String(password), salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch { return false; }
}

export function createAdminSession(username, secret) {
  const payload = Buffer.from(JSON.stringify({ sub: username, role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600, nonce: randomToken() })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyAdminSession(token, secret) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const expected = createHmac('sha256', secret).update(parts[0]).digest('base64url');
  if (!secureEqual(parts[1], expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    return payload.role === 'admin' && payload.sub === process.env.ADMIN_USERNAME && Number.isInteger(payload.exp) && payload.exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}

export function requireKeys() {
  for (const name of ['ADMIN_SESSION_KEY', 'INTEGRITY_HMAC_KEY', 'CPF_HMAC_KEY']) {
    if (!process.env[name] || process.env[name].length < 32) {
      throw new Error(`${name} deve ser configurada com pelo menos 32 caracteres.`);
    }
  }
  if (!process.env.ADMIN_USERNAME || !validPasswordHash(process.env.ADMIN_PASSWORD_HASH)) {
    throw new Error('Configure ADMIN_USERNAME e ADMIN_PASSWORD_HASH no formato salt:hash.');
  }
}
