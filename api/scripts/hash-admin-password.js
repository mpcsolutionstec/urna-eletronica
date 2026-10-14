import { randomBytes, scryptSync } from 'node:crypto';

if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
  console.error('Execute este comando em um terminal interativo para ocultar a senha digitada.');
  process.exit(1);
}

const input = process.stdin;
let password = '';
process.stdout.write('Nova senha administrativa (entrada oculta): ');
input.setRawMode(true);
input.resume();
input.setEncoding('utf8');
input.on('data', (chunk) => {
  for (const char of chunk) {
    if (char === '\u0003') {
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\nCancelado.\n');
      process.exit(130);
    }
    if (char === '\r' || char === '\n') {
      if (password.length < 12) {
        process.stdout.write('\nUse uma senha com pelo menos 12 caracteres.\n');
        password = '';
        process.stdout.write('Nova senha administrativa (entrada oculta): ');
        continue;
      }
      const salt = randomBytes(16).toString('base64url');
      const hash = scryptSync(password, salt, 64).toString('base64url');
      input.setRawMode(false);
      input.pause();
      process.stdout.write(`\nADMIN_PASSWORD_HASH=${salt}:${hash}\n`);
      password = '';
      process.exit(0);
    }
    if (char === '\u007f' || char === '\b') password = password.slice(0, -1);
    else if (char >= ' ' && char !== '\u007f') password += char;
  }
});
