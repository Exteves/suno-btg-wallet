// Runs after each scheduled collection (systemd ExecStopPost). systemd sets
// EXIT_STATUS to the collector's exit code (or a signal name on kill/timeout).
import { privatePath } from './privacy.js';
import { readHealth, notificationFor } from './suno-kb/health.js';
import { notifyWindows } from './windows-notify.js';

let health = null;
try { health = readHealth(privatePath('privado/suno-conhecimento.sqlite')); } catch { /* notify from the exit code alone */ }
const status = process.env.SERVICE_RESULT === 'timeout' ? 'timeout' : process.env.EXIT_STATUS;
const note = notificationFor(status, health);
if (note) {
  const shown = await notifyWindows(note.title, note.message);
  console.log(`${note.title}: ${note.message}${shown ? '' : ' (notificação do Windows indisponível)'}`);
}
