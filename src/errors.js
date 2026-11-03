const messages = {
  BROWSER_PERMISSION_DENIED: 'O ambiente bloqueou operações do Chromium (Operation not permitted). Execute em um terminal fora deste ambiente restrito; reinstalar o navegador não remove esse bloqueio.',
  BROWSER_LIBRARY_MISSING: 'Falta uma biblioteca do Chromium. Execute npx playwright install-deps chromium na máquina local.',
  BROWSER_NOT_INSTALLED: 'Chromium não está instalado. Execute npm run browser:install.',
  DISPLAY_UNAVAILABLE: 'O Chromium não consegue acessar o ambiente gráfico. Verifique DISPLAY/Wayland ou WSLg na máquina local.',
  BROWSER_LAUNCH_FAILED: 'O Chromium não conseguiu iniciar. Execute npm run doctor para verificar o ambiente.',
  NETWORK_DNS_FAILED: 'O domínio do site consultado não pôde ser resolvido (DNS). Verifique a rede/DNS do ambiente que executa o coletor.',
  NETWORK_TIMEOUT: 'O acesso ao site excedeu o tempo limite. Verifique a rede e tente novamente.',
  NETWORK_TLS_FAILED: 'Falha no certificado TLS da conexão. Verifique certificados e proxy; a validação TLS permanece habilitada.',
  NETWORK_FAILED: 'Não foi possível abrir o site. Execute npm run doctor e verifique a conexão.',
  KEYRING_TOOL_MISSING: 'secret-tool não está instalado. No Ubuntu/WSL, instale libsecret-tools e configure um chaveiro Secret Service, ou use --no-session para login manual sem persistência.',
  KEYRING_UNAVAILABLE: 'O chaveiro Secret Service não está acessível ou está bloqueado. Abra/desbloqueie o chaveiro na sua sessão Linux e execute novamente. Nenhuma sessão será salva sem criptografia.',
  KEYRING_UNSUPPORTED: 'A persistência implementada usa o chaveiro Linux Secret Service. Nesta plataforma, use --no-session.',
  SESSION_KEY_MISSING: 'A chave desta sessão não está disponível no chaveiro. Desbloqueie o chaveiro; se a chave foi perdida, execute npm run session:forget e faça login novamente.',
  SESSION_INVALID: 'A sessão salva está corrompida, foi alterada ou não pôde ser autenticada. Execute npm run session:forget e faça login novamente.',
  SESSION_PATH_UNSAFE: 'O arquivo de sessão deve ser um arquivo privado regular, sem links simbólicos no diretório de autenticação.',
  SESSION_IO_FAILED: 'Não foi possível ler ou gravar a sessão criptografada em privado/auth/. Verifique permissões e espaço livre.',
  SESSION_EMPTY: 'Nenhum estado de autenticação compatível foi encontrado. Verifique os nomes das chaves de autenticação na configuração ou use --no-session. Nenhum perfil completo será salvo.',
  SESSION_LOGIN_REQUIRED: 'A sessão não pôde ser confirmada. Execute o coletor em um terminal interativo para autenticar diretamente no navegador.',
  SESSION_LOGIN_UNCONFIRMED: 'A página autenticada não foi confirmada. Abra a área configurada após o login e tente novamente; a sessão não foi salva.',
  SESSION_CANCELLED: 'Execução interrompida.',
  HTTP_ERROR: 'O site respondeu com erro HTTP antes da coleta. Verifique o acesso no navegador.',
  CONFIG_INVALID: 'Configuração inválida. Verifique o arquivo de configuração da fonte e o README.',
  CLI_USAGE: 'Uso Suno: npm run scrape -- --purpose start|rebalance [--no-session]. Uso BTG: npm run scrape:btg. Diagnóstico: npm run doctor -- --source suno|btg.',
  UNEXPECTED_FAILURE: 'Falha na execução. Detalhes privados da página não foram registrados. Execute npm run doctor para verificar o ambiente.',
};

export class AppError extends Error {
  constructor(code) { super(messages[code] || messages.UNEXPECTED_FAILURE); this.code = code; }
}

export function classifyBrowserError(error) {
  const text = String(error?.message || '');
  if (/Operation not permitted|\bEPERM\b|\bEACCES\b/.test(text)) return new AppError('BROWSER_PERMISSION_DENIED');
  if (/error while loading shared libraries|Host system is missing dependencies/.test(text)) return new AppError('BROWSER_LIBRARY_MISSING');
  if (/Executable doesn't exist/.test(text)) return new AppError('BROWSER_NOT_INSTALLED');
  if (/Missing X server|cannot open display|Failed to connect to.*display|X11 connection rejected/i.test(text)) return new AppError('DISPLAY_UNAVAILABLE');
  return new AppError('BROWSER_LAUNCH_FAILED');
}

export function classifyNetworkError(error) {
  const text = String(error?.message || '');
  if (['EAI_AGAIN', 'ENOTFOUND'].includes(error?.code) || /ERR_NAME_NOT_RESOLVED|ERR_DNS_|EAI_AGAIN|ENOTFOUND/.test(text)) return new AppError('NETWORK_DNS_FAILED');
  if (error?.name === 'TimeoutError' || /ETIMEDOUT|ERR_CONNECTION_TIMED_OUT/.test(text)) return new AppError('NETWORK_TIMEOUT');
  if (/ERR_CERT_|CERT_|SSL_|TLS_/.test(text)) return new AppError('NETWORK_TLS_FAILED');
  return new AppError('NETWORK_FAILED');
}

export function publicError(error) {
  const safe = error instanceof AppError ? error : new AppError('UNEXPECTED_FAILURE');
  return { code: safe.code, message: safe.message };
}
