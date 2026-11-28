// Diagnostics for the scheduled collection, written to the journal (no page
// contents, URLs with parameters, headers or session data).
//
// Failure seen on 2026-11-24: the timer fired while Windows was resuming from
// sleep (clock jumps in the journal), the WSLg compositor (weston, rdp-backend)
// segfaulted as Chromium opened its window, the browser died and newContext()
// never settled; Node then exited with code 13 without reaching any handler.
import { existsSync } from 'node:fs';
import { uptime } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, classifyBrowserError } from '../errors.js';
import { redact } from '../privacy.js';

// Wall clock minus monotonic time since start: grows when the machine sleeps.
const wallStart = Date.now();
const monoStart = performance.now();
export const clockJumpMs = () => Math.round((Date.now() - wallStart) - (performance.now() - monoStart));

export function displayState(env = process.env, exists = existsSync) {
  const runtime = env.XDG_RUNTIME_DIR;
  return {
    display: env.DISPLAY || null,
    wayland: env.WAYLAND_DISPLAY || null,
    x11Socket: exists('/tmp/.X11-unix/X0'),
    waylandSocket: !!(env.WAYLAND_DISPLAY && runtime && exists(`${runtime}/${env.WAYLAND_DISPLAY}`)) || exists('/mnt/wslg/runtime-dir/wayland-0'),
    uptimeMin: Math.round(uptime() / 60),
    clockJumpSec: Math.round(clockJumpMs() / 1000),
  };
}

// Keeps the last browser process messages (stderr, launch steps) in memory,
// to be printed only when something fails.
export class BrowserLog {
  constructor(size = 40) { this.size = size; this.lines = []; }
  get logger() {
    return {
      isEnabled: name => name === 'browser',
      log: (name, severity, message) => {
        const text = redact(String(message)).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 300);
        this.lines.push(`${severity}: ${text}`);
        if (this.lines.length > this.size) this.lines.shift();
      },
    };
  }
  tail(n = 15) { return this.lines.slice(-n); }
}

const deadline = (ms, code) => sleep(ms, undefined, { ref: false }).then(() => { throw new AppError(code); });
const permanent = new Set(['BROWSER_PERMISSION_DENIED', 'BROWSER_LIBRARY_MISSING', 'BROWSER_CHANNEL_MISSING', 'BROWSER_NOT_INSTALLED']);

async function waitForDisplay(log, { timeoutMs, env, exists }) {
  const start = Date.now();
  let state = displayState(env, exists);
  if (!state.display && !state.wayland) return state; // headless or no GUI configured: let launch report it
  while (!state.x11Socket && !state.waylandSocket && Date.now() - start < timeoutMs) {
    await sleep(5000);
    state = displayState(env, exists);
  }
  if (Date.now() - start > 1000) log(`Tela gráfica ${state.x11Socket || state.waylandSocket ? 'disponível' : 'ainda indisponível'} após ${Math.round((Date.now() - start) / 1000)}s.`);
  return state;
}

// Launches Chromium and opens the context and page, retrying when the browser
// dies during start-up (e.g. the WSLg compositor restarting after a resume).
export async function openBrowser({ chromium, launchOptions, contextOptions, log, attempts = 3, retryDelayMs = 30000,
  stepTimeoutMs = 90000, displayTimeoutMs = 120000, env = process.env, exists = existsSync, onBrowser = () => {} }) {
  for (let attempt = 1; ; attempt++) {
    const browserLog = new BrowserLog();
    let browser;
    let step = 'aguardando tela';
    try {
      const display = await waitForDisplay(log, { timeoutMs: displayTimeoutMs, env, exists });
      if (display.clockJumpSec > 30) log(`Relógio avançou ${display.clockJumpSec}s desde o início: o computador provavelmente estava suspenso.`);
      step = 'abrindo Chromium';
      try { browser = await Promise.race([chromium.launch({ ...launchOptions, logger: browserLog.logger }), deadline(stepTimeoutMs, 'BROWSER_START_TIMEOUT')]); }
      catch (error) { throw error instanceof AppError ? error : classifyBrowserError(error); }
      onBrowser(browser);
      const disconnected = new Promise((_, reject) => browser.once('disconnected', () => reject(new AppError('BROWSER_DISCONNECTED'))));
      disconnected.catch(() => {});
      const guard = promise => Promise.race([promise, disconnected, deadline(stepTimeoutMs, 'BROWSER_START_TIMEOUT')]);
      step = 'criando contexto';
      const context = await guard(browser.newContext(contextOptions));
      step = 'abrindo aba';
      const page = await guard(context.newPage());
      if (attempt > 1) log(`Navegador aberto na tentativa ${attempt}.`);
      return { browser, context, page, browserLog };
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'BROWSER_LAUNCH_FAILED';
      log(`Falha ao abrir o navegador (${step}, tentativa ${attempt}/${attempts}): ${code}. Ambiente: ${JSON.stringify(displayState(env, exists))}`);
      for (const line of browserLog.tail()) log(`  [chromium] ${line}`);
      await browser?.close().catch(() => {});
      if (attempt >= attempts || permanent.has(code)) throw Object.assign(error instanceof AppError ? error : new AppError(code), { stage: step });
      await sleep(retryDelayMs);
    }
  }
}
