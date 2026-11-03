import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

const application = 'suno-portfolio-scraper';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validKeyId(id) { return typeof id === 'string' && uuidPattern.test(id); }

// No shell, no secret in argv/env, and no inherited stdout/stderr.
function runSecretTool(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('secret-tool', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    let stderrPresent = false;
    let length = 0;
    const timeout = setTimeout(() => { child.kill(); reject(new AppError('KEYRING_UNAVAILABLE')); }, 30000);
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > 8192) { child.kill(); reject(new AppError('KEYRING_UNAVAILABLE')); }
      else output.push(chunk);
    });
    child.stderr.on('data', chunk => { if (chunk.length) stderrPresent = true; });
    child.stdin.on('error', () => {});
    child.once('error', error => {
      clearTimeout(timeout);
      reject(new AppError(error.code === 'ENOENT' ? 'KEYRING_TOOL_MISSING' : 'KEYRING_UNAVAILABLE'));
    });
    child.once('close', code => {
      clearTimeout(timeout);
      resolve({ code, stdout: Buffer.concat(output).toString('utf8').trim(), stderrPresent });
    });
    child.stdin.end(input);
  });
}

export class SecretServiceKeyring {
  constructor({ run = runSecretTool, platform = process.platform } = {}) {
    this.run = run;
    this.platform = platform;
  }

  attributes(id) {
    if (!validKeyId(id)) throw new AppError('SESSION_INVALID');
    return ['application', application, 'vault', id];
  }

  async check() {
    if (this.platform !== 'linux') throw new AppError('KEYRING_UNSUPPORTED');
    // A lookup in a fresh, app-specific probe namespace checks the service
    // without retrieving existing credentials or writing a probe secret.
    const result = await this.run(['lookup', 'application', application, 'probe', randomUUID()]);
    if (result.code !== 1 || result.stderrPresent || result.stdout) throw new AppError('KEYRING_UNAVAILABLE');
  }

  async get(id) {
    const result = await this.run(['lookup', ...this.attributes(id)]);
    if (result.code === 1 && !result.stderrPresent && !result.stdout) throw new AppError('SESSION_KEY_MISSING');
    if (result.code !== 0) throw new AppError('KEYRING_UNAVAILABLE');
    if (!/^[A-Za-z0-9+/]{43}=$/.test(result.stdout)) throw new AppError('SESSION_INVALID');
    return Buffer.from(result.stdout, 'base64');
  }

  async set(id, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new AppError('SESSION_INVALID');
    const result = await this.run(['store', '--collection=default', '--label=Suno scraper: session encryption key', ...this.attributes(id)], key.toString('base64'));
    if (result.code !== 0) throw new AppError('KEYRING_UNAVAILABLE');
  }

  async delete(id) {
    const result = await this.run(['clear', ...this.attributes(id)]);
    // libsecret may report no matching item with exit 1 and no error text.
    if (result.code === 1 && !result.stderrPresent && !result.stdout) return;
    if (result.code !== 0) throw new AppError('KEYRING_UNAVAILABLE');
  }
}
