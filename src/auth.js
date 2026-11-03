import { assertReadable, settle } from './extract.js';
import { AppError } from './errors.js';

export async function confirmAuthentication(page, config, manualLogin) {
  if (config.authenticatedSelector) {
    try {
      await page.locator(config.authenticatedSelector).first().waitFor({ state: 'visible', timeout: 5000 });
      await assertReadable(page, config);
      if (await settle(page, config)) return 'confirmed-by-selector';
    } catch { /* An expired or unconfirmed session needs interactive login. */ }
  }
  // With an unverified layout, never treat a cookie or a route as proof of login.
  await manualLogin();
  try {
    await assertReadable(page, config);
    if (config.authenticatedSelector) await page.locator(config.authenticatedSelector).first().waitFor({ state: 'visible', timeout: 5000 });
    if (!await settle(page, config)) throw new Error();
    return 'confirmed-interactively';
  } catch { throw new AppError('SESSION_LOGIN_UNCONFIRMED'); }
}
