import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionVault, filterSessionState } from '../src/session-vault.js';
import { SecretServiceKeyring } from '../src/keyring.js';
import { AppError, classifyBrowserError, classifyNetworkError, publicError } from '../src/errors.js';
import { confirmAuthentication } from '../src/auth.js';

const state = {
  cookies: [{ name: 'suno_session', value: 'SYNTHETIC-COOKIE-SECRET', domain: '.suno.com.br', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
  origins: [{ origin: 'https://investidor.suno.com.br', localStorage: [{ name: 'access_token', value: 'SYNTHETIC-TOKEN-SECRET' }] }],
};
const memoryKeyring = () => ({
  keys: new Map(),
  async get(id) { if (!this.keys.has(id)) throw new AppError('SESSION_KEY_MISSING'); return Buffer.from(this.keys.get(id)); },
  async set(id, key) { this.keys.set(id, Buffer.from(key)); },
  async delete(id) { this.keys.delete(id); },
});

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'suno-vault-test-'));
  const path = join(directory, 'auth', 'session.enc.json');
  const keyring = memoryKeyring();
  const vault = new SessionVault(path, keyring, options);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path, keyring, vault };
}

test('session state survives a new vault instance, with ciphertext only on disk and no key alongside it', async t => {
  const { path, keyring, vault } = await fixture(t);
  assert.deepEqual(await vault.load(), { state: null, reason: 'absent' });
  await vault.save(state);
  const bytes = await readFile(path, 'utf8');
  assert.ok(!bytes.includes('SYNTHETIC-COOKIE-SECRET'));
  assert.ok(!bytes.includes('SYNTHETIC-TOKEN-SECRET'));
  assert.ok(!bytes.includes('access_token'));
  assert.equal(keyring.keys.size, 1);
  assert.ok(!bytes.includes([...keyring.keys.values()][0].toString('base64')));
  const restored = await new SessionVault(path, keyring).load();
  assert.deepEqual(restored.state, state);
  assert.equal(restored.reason, 'restored');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700);
  const first = JSON.parse(bytes);
  await vault.save(state);
  const second = JSON.parse(await readFile(path, 'utf8'));
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.keyId, second.keyId);
  assert.equal(keyring.keys.size, 1);
});

test('ciphertext tampering, metadata tampering and wrong keys fail closed without leaking secrets', async t => {
  const { vault, path, keyring } = await fixture(t);
  await vault.save(state);
  const original = JSON.parse(await readFile(path, 'utf8'));
  for (const variant of [
    { ...original, expiresAt: original.expiresAt - 1000 },
    { ...original, ciphertext: (original.ciphertext[0] === 'A' ? 'B' : 'A') + original.ciphertext.slice(1) },
  ]) {
    await writeFile(path, JSON.stringify(variant));
    await assert.rejects(vault.load(), error => error.code === 'SESSION_INVALID' && !error.message.includes('SYNTHETIC'));
    assert.equal(keyring.keys.size, 1);
  }
  await writeFile(path, JSON.stringify(original));
  keyring.keys.set(original.keyId, Buffer.alloc(32, 1));
  await assert.rejects(vault.load(), { code: 'SESSION_INVALID' });
});

test('local expiry removes both encrypted state and its key and requests a new login', async t => {
  let clock = 1000000;
  const { vault, keyring, path } = await fixture(t, { now: () => clock, ttlMs: 3600000 });
  await vault.save(state);
  clock += 3600000;
  assert.deepEqual(await vault.load(), { state: null, reason: 'expired' });
  assert.equal(keyring.keys.size, 0);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('missing or unavailable keyring never creates a plaintext fallback or overwrites existing encrypted state', async t => {
  const { vault, keyring, path } = await fixture(t);
  const originalSet = keyring.set;
  keyring.set = async () => { throw new AppError('KEYRING_UNAVAILABLE'); };
  await assert.rejects(vault.save(state), { code: 'KEYRING_UNAVAILABLE' });
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  keyring.set = originalSet;
  await vault.save(state);
  const original = await readFile(path, 'utf8');
  keyring.keys.clear();
  await assert.rejects(vault.load(), { code: 'SESSION_KEY_MISSING' });
  await assert.rejects(vault.save(state), { code: 'SESSION_KEY_MISSING' });
  assert.equal(await readFile(path, 'utf8'), original);
});

test('forget removes local session and key; malformed state can be explicitly removed', async t => {
  const { vault, keyring, path } = await fixture(t);
  await vault.save(state);
  await vault.forget();
  assert.equal(keyring.keys.size, 0);
  assert.deepEqual(await vault.load(), { state: null, reason: 'absent' });
  await writeFile(path, '{broken-json');
  await assert.rejects(vault.load(), { code: 'SESSION_INVALID' });
  await vault.forget();
  await vault.forget();
  assert.deepEqual(await vault.load(), { state: null, reason: 'absent' });
});

test('vault refuses symbolic links instead of following a path outside the private auth directory', async t => {
  const { directory, vault, path } = await fixture(t);
  const elsewhere = await mkdtemp(join(tmpdir(), 'suno-vault-target-'));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  await symlink(elsewhere, join(directory, 'auth'));
  await assert.rejects(vault.save(state), { code: 'SESSION_PATH_UNSAFE' });
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('storage filter retains first-party authentication and drops unrelated origins, profiles, tracking and financial storage', () => {
  const input = structuredClone(state);
  input.cookies.push({ ...input.cookies[0], name: '_ga', value: 'TRACKING' });
  input.cookies.push({ ...input.cookies[0], name: 'profile', value: 'PRIVATE-PROFILE' });
  input.cookies.push({ ...input.cookies[0], domain: 'other.test', value: 'OTHER-SITE-SECRET' });
  input.origins.push({ origin: 'https://other.test', localStorage: [{ name: 'access_token', value: 'OTHER-TOKEN' }] });
  input.origins[0].localStorage.push({ name: 'portfolio', value: 'PRIVATE-FINANCIALS' }, { name: 'customLogin', value: 'CUSTOM-AUTH' });
  input.origins[0].localStorage.push({ name: 'authProfile', value: JSON.stringify({ token: 'TOKEN', cpf: 'SYNTHETIC-CPF' }) });
  const config = { baseUrl: state.origins[0].origin, sessionLocalStorageKeys: [] };
  assert.deepEqual(filterSessionState(input, config), state);
  assert.equal(filterSessionState(input, { ...config, sessionLocalStorageKeys: ['customLogin'] }).origins[0].localStorage.length, 2);
  assert.throws(() => filterSessionState({ cookies: [], origins: [] }, config), { code: 'SESSION_EMPTY' });
});

function authPage({ loggedIn = false, marker = true } = {}) {
  const page = {
    loggedIn, marker,
    url: () => 'https://investidor.suno.com.br/portfolio',
    waitForTimeout: async () => {},
    locator: selector => ({
      first() { return this; },
      count: async () => selector.includes('password') && !page.loggedIn ? 1 : 0,
      innerText: async () => page.loggedIn ? 'Meu portfólio - Ativos' : 'Faça login para continuar',
      waitFor: async () => {
        if (selector === '[data-authenticated]' && !(page.loggedIn && page.marker)) throw new Error('marker absent');
      },
    }),
  };
  return page;
}

const authConfig = {
  baseUrl: 'https://investidor.suno.com.br', scopePaths: ['/portfolio'], queryKeys: [],
  authenticatedSelector: '[data-authenticated]', contentSelector: 'main', settleMs: 1, navigationTimeoutMs: 10,
};

test('valid restored login skips the manual prompt only when the authenticated selector confirms it', async () => {
  const page = authPage({ loggedIn: true });
  let prompts = 0;
  assert.equal(await confirmAuthentication(page, authConfig, async () => { prompts++; }), 'confirmed-by-selector');
  assert.equal(prompts, 0);
});

test('expired server session requests interactive login and only accepts the authenticated result', async () => {
  const page = authPage();
  let prompts = 0;
  assert.equal(await confirmAuthentication(page, authConfig, async () => { prompts++; page.loggedIn = true; }), 'confirmed-interactively');
  assert.equal(prompts, 1);
  const stillLoggedOut = authPage();
  await assert.rejects(confirmAuthentication(stillLoggedOut, authConfig, async () => {}), { code: 'SESSION_LOGIN_UNCONFIRMED' });
});

test('unverified layout still requires confirmation even when session cookies have been restored', async () => {
  const page = authPage({ loggedIn: true });
  let prompts = 0;
  assert.equal(await confirmAuthentication(page, { ...authConfig, authenticatedSelector: null }, async () => { prompts++; }), 'confirmed-interactively');
  assert.equal(prompts, 1);
});

test('keyring sends encryption keys over stdin only, with narrow app/vault attributes', async () => {
  const calls = [];
  const key = Buffer.alloc(32, 7);
  const id = randomUUID();
  const keyring = new SecretServiceKeyring({ platform: 'linux', run: async (args, input) => {
    calls.push({ args, input });
    return { code: 0, stdout: args[0] === 'lookup' ? key.toString('base64') : '', stderrPresent: false };
  } });
  await keyring.set(id, key);
  assert.ok(!calls[0].args.join(' ').includes(key.toString('base64')));
  assert.equal(calls[0].input, key.toString('base64'));
  assert.ok(calls[0].args.includes('suno-portfolio-scraper'));
  assert.ok(calls[0].args.includes(id));
  assert.deepEqual(await keyring.get(id), key);
  await keyring.delete(id);
  await assert.rejects(keyring.get('arbitrary-other-key'), { code: 'SESSION_INVALID' });
  const unsupported = new SecretServiceKeyring({ platform: 'darwin' });
  await assert.rejects(unsupported.check(), { code: 'KEYRING_UNSUPPORTED' });
  const alreadyDeleted = new SecretServiceKeyring({ run: async () => ({ code: 1, stdout: '', stderrPresent: false }) });
  await alreadyDeleted.delete(id);
  const locked = new SecretServiceKeyring({ run: async () => ({ code: 1, stdout: '', stderrPresent: true }) });
  await assert.rejects(locked.delete(id), { code: 'KEYRING_UNAVAILABLE' });
});

test('diagnostics expose actionable causes and never echo browser URLs, credentials or raw exception text', () => {
  assert.equal(classifyBrowserError(new Error('setsockopt: Operation not permitted (1)')).code, 'BROWSER_PERMISSION_DENIED');
  assert.equal(classifyBrowserError(new Error('error while loading shared libraries: libasound.so.2')).code, 'BROWSER_LIBRARY_MISSING');
  assert.equal(classifyBrowserError(new Error("Executable doesn't exist")).code, 'BROWSER_NOT_INSTALLED');
  assert.equal(classifyNetworkError(new Error('net::ERR_NAME_NOT_RESOLVED https://site/?token=SECRET')).code, 'NETWORK_DNS_FAILED');
  assert.equal(classifyNetworkError(Object.assign(new Error('SECRET'), { code: 'EAI_AGAIN' })).code, 'NETWORK_DNS_FAILED');
  assert.equal(classifyNetworkError(new Error('net::ERR_CERT_AUTHORITY_INVALID')).code, 'NETWORK_TLS_FAILED');
  assert.ok(!JSON.stringify(publicError(new Error('SECRET-COOKIE'))).includes('SECRET-COOKIE'));
});
