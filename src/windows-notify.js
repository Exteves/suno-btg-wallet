// Windows toast from WSL, through powershell.exe. Only fixed, non-personal
// messages are sent; nothing from the database or the session goes here.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
// AppUserModelID of Windows PowerShell: lets an unregistered script show toasts.
const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const quote = text => `'${String(text).replace(/'/g, "''").replace(/[\r\n]+/g, ' ').slice(0, 300)}'`;

export function toastScript(title, message) {
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    '$text = $xml.GetElementsByTagName("text")',
    `$text.Item(0).AppendChild($xml.CreateTextNode(${quote(title)})) > $null`,
    `$text.Item(1).AppendChild($xml.CreateTextNode(${quote(message)})) > $null`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${quote(APP_ID)}).Show([Windows.UI.Notifications.ToastNotification]::new($xml))`,
  ].join('\n');
}

export function notifyWindows(title, message, { powershell = POWERSHELL } = {}) {
  if (!existsSync(powershell)) return Promise.resolve(false);
  const encoded = Buffer.from(toastScript(title, message), 'utf16le').toString('base64');
  return new Promise(resolve => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 30000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}
