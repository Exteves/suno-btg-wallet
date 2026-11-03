import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFile, open, rename, unlink, lstat, mkdir, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AppError } from './errors.js';
import { validKeyId } from './keyring.js';

const day = 86400000;
const maxSize = 10 * 1024 * 1024;
const purpose = 'suno-portfolio-scraper/auth-session/v1';

function metadata(envelope) {
  return Buffer.from(JSON.stringify([purpose, envelope.keyId, envelope.createdAt, envelope.expiresAt]));
}

function validateEnvelope(e) {
  if (!e || typeof e !== 'object' || e.version !== 1 || e.algorithm !== 'aes-256-gcm' || !validKeyId(e.keyId)
    || !Number.isSafeInteger(e.createdAt) || !Number.isSafeInteger(e.expiresAt)
    || e.expiresAt <= e.createdAt || e.expiresAt - e.createdAt > 7 * day
    || typeof e.iv !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(e.iv)
    || typeof e.tag !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(e.tag)
    || typeof e.ciphertext !== 'string' || !e.ciphertext.length
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(e.ciphertext)) throw new AppError('SESSION_INVALID');
  return e;
}

function validateState(state) {
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new AppError('SESSION_INVALID');
  if (!state.cookies.length && !state.origins.some(o => o.localStorage?.length)) throw new AppError('SESSION_EMPTY');
  return state;
}

// Only first-party Suno cookies and explicitly auth-related storage entries.
// Never persist arbitrary localStorage, sessionStorage, IndexedDB, or form fields.
export function filterSessionState(state, { baseUrl, sessionLocalStorageKeys = [] }) {
  const domainAllowed = domain => {
    const clean = domain.replace(/^\./, '').toLowerCase();
    return clean === 'suno.com.br' || clean.endsWith('.suno.com.br');
  };
  const privateName = /(?:password|senha|cpf|conta|account.number|profile|email|(?:^|[_.:-])(?:otp|totp|mfa)(?:$|[_.:-])|code_verifier|code_challenge)/i;
  const trackingName = /^(?:_ga(?:_|$)|_gid|_gat|_fbp|_gcl|amplitude|ajs_)/i;
  const forbiddenFields = value => {
    if (Array.isArray(value)) return value.some(forbiddenFields);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, item]) => /^(?:password|passwd|senha|cpf|email|account_?number|numero_?conta|profile|user_?(?:info|data)|otp|totp|verification_?code)$/i.test(key) || forbiddenFields(item));
  };
  const containsPrivateJson = value => {
    try { return forbiddenFields(JSON.parse(value)); } catch { return false; }
  };
  const cookies = state.cookies.filter(cookie => domainAllowed(cookie.domain) && !privateName.test(cookie.name) && !trackingName.test(cookie.name) && !containsPrivateJson(cookie.value));
  const origins = state.origins.filter(entry => {
    try { return new URL(entry.origin).origin === new URL(baseUrl).origin; } catch { return false; }
  }).map(entry => ({ origin: entry.origin, localStorage: entry.localStorage.filter(item =>
    !privateName.test(item.name) && !containsPrivateJson(item.value)
    && (sessionLocalStorageKeys.includes(item.name) || /(?:token|auth|session|oidc|msal|cognito)/i.test(item.name))
  ) })).filter(entry => entry.localStorage.length);
  return validateState({ cookies, origins });
}

export class SessionVault {
  constructor(path, keyring, { now = Date.now, ttlMs = 7 * day } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 7 * day) throw new AppError('CONFIG_INVALID');
    this.path = resolve(path);
    this.keyring = keyring;
    this.now = now;
    this.ttlMs = ttlMs;
  }

  async checkDirectories() {
    let directory = dirname(this.path);
    while (true) {
      try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError('SESSION_PATH_UNSAFE');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (directory === dirname(directory)) return;
      directory = dirname(directory);
    }
  }

  async readEnvelope() {
    try {
      await this.checkDirectories();
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink()) throw new AppError('SESSION_PATH_UNSAFE');
      if (info.size > maxSize) throw new AppError('SESSION_INVALID');
      // Tighten an accidentally broadened permission before reading ciphertext.
      await chmod(this.path, 0o600);
      return validateEnvelope(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof AppError) throw error;
      if (error instanceof SyntaxError) throw new AppError('SESSION_INVALID');
      throw new AppError('SESSION_IO_FAILED');
    }
  }

  async load() {
    const envelope = await this.readEnvelope();
    if (!envelope) return { state: null, reason: 'absent' };
    const key = await this.keyring.get(envelope.keyId);
    let plaintext;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(metadata(envelope));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
      const state = validateState(JSON.parse(plaintext.toString('utf8')));
      // Authenticate metadata before trusting expiry or deleting a key.
      if (this.now() >= envelope.expiresAt || this.now() - envelope.createdAt >= this.ttlMs) {
        await this.forget();
        return { state: null, reason: 'expired' };
      }
      if (envelope.createdAt > this.now() + 300000) throw new AppError('SESSION_INVALID');
      return { state, reason: 'restored' };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('SESSION_INVALID');
    } finally { key.fill(0); plaintext?.fill(0); }
  }

  async save(state) {
    validateState(state);
    const previous = await this.readEnvelope();
    // One key per vault, new random nonce for every encryption.
    const keyId = previous?.keyId || randomUUID();
    const key = previous ? await this.keyring.get(keyId) : randomBytes(32);
    const plaintext = Buffer.from(JSON.stringify(state));
    const temporary = join(dirname(this.path), `.session-${randomUUID()}.tmp`);
    let keyCreated = false;
    try {
      const envelope = { version: 1, algorithm: 'aes-256-gcm', keyId, createdAt: this.now(), expiresAt: this.now() + this.ttlMs };
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(metadata(envelope));
      envelope.ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64');
      envelope.iv = iv.toString('base64');
      envelope.tag = cipher.getAuthTag().toString('base64');
      if (!previous) { await this.keyring.set(keyId, key); keyCreated = true; }
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const directory = await lstat(dirname(this.path));
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new AppError('SESSION_PATH_UNSAFE');
      await chmod(dirname(this.path), 0o700);
      const serialized = JSON.stringify(envelope);
      if (Buffer.byteLength(serialized) > maxSize) throw new AppError('SESSION_INVALID');
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(serialized); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      if (keyCreated) await this.keyring.delete(keyId).catch(() => {});
      if (error instanceof AppError) throw error;
      throw new AppError('SESSION_IO_FAILED');
    } finally { key.fill(0); plaintext.fill(0); }
  }

  async forget() {
    // Even malformed ciphertext can be removed explicitly, without trusting its key id.
    let envelope;
    try { envelope = await this.readEnvelope(); }
    catch (error) { if (error.code !== 'SESSION_INVALID') throw error; }
    if (envelope) await this.keyring.delete(envelope.keyId);
    try { await unlink(this.path); }
    catch (error) { if (error.code !== 'ENOENT') throw new AppError('SESSION_IO_FAILED'); }
  }
}
