# Contexto — 2026-11-02

## Atualização em 2026-11-03 — BTG e objetivo privado

Usuário solicitou coletor Playwright de todos os produtos exibidos em
https://app.btgpactual.com/produtos-de-investimento, com login manual e armazenamento
SQLite para apoiar futura consolidação com Portfólio/Carteiras da Suno. A alocação
informada está em `privado/plano-carteira.json`, sem copiar números para contexto
versionável. O plano foi registrado no banco existente como objetivo do usuário,
separado de posições, recomendações e produtos observados.

Novo comando `npm run scrape:btg`, configuração `btg.config.json` e guia
`docs/BTG.md`. Banco compartilhado padrão: `privado/suno.sqlite`, por compatibilidade.
Migração aditiva v2: runs.provider, snapshots.captured_url, catalog_products,
catalog_observations, allocation_plans e allocation_targets. `npm run wallet:plan`
registra o plano de forma idempotente. BTG tem sessão temporária; a persistência
anterior continua restrita à Suno. Nenhuma operação financeira foi autorizada.

Testes unitários atuais: 24 passaram. Os testes de navegador incluem fixture BTG,
mas continuam impedidos pelas restrições locais. `npm run doctor -- --source btg`
confirmou bloqueio Chromium (Operation not permitted) e falha de DNS do BTG.
Nenhuma sessão ou coleta real do BTG foi obtida. Consulta pública da URL via web
não retornou conteúdo legível. Falta validar seletores, categorias, paginação,
detalhes e APIs de consulta com a página autenticada. Não afirmar catálogo integral,
disponibilidade para compra ou carteira consolidada por produtos sem essa validação.

## Histórico anterior

Pedido: criar coletor Playwright das áreas Portfólio e Carteiras da Suno,
incluindo carteiras disponíveis, com armazenamento SQLite. Uso pontual ao iniciar
ou rebalancear uma carteira. Não foi autorizada nenhuma operação financeira nem
alteração de conta. BTG permanece fora desta implementação.

Implementação em Node.js 24+, Playwright e SQLite nativo. O usuário autorizou
explicitamente persistência criptografada do login em 2026-11-02; AGENTS.md foi
atualizado com essa exceção limitada. Login/MFA continuam manuais. Estado filtrado
em `privado/auth/suno.session.enc.json` (AES-256-GCM), chave aleatória de 256 bits
no chaveiro Linux Secret Service via secret-tool. Sem fallback em texto aberto,
sem senha ou códigos persistidos, sem chave no projeto ou variáveis de ambiente.
Dados financeiros em `privado/suno.sqlite`, ignorado pelo versionamento. Nenhuma
coleta real ou credencial foi disponibilizada.

`npm test`: 17 testes unitários passaram, incluindo sessão/criptografia com chaveiro
simulado e dados sintéticos. Testes de navegador foram preparados,
mas o ambiente impediu a execução: rede/DNS indisponível para a Suno; Chromium
inicialmente sem libasound e, com a biblioteca disponível, bloqueado na criação de
seu processo de sandbox. Não houve execução autenticada. Não solicitar credenciais
no chat; o usuário pode autenticar diretamente no navegador na máquina local.

Pendências de integração: confirmar rota Carteiras e detalhes, seletores de
conteúdo/prontidão, abas/paginação, eventuais APIs de consulta GraphQL, rolagem
interna e cabeçalhos de ativos. `layoutVerified` permanece false. `/carteiras` é
uma hipótese, não uma rota verificada. Ver README para operação e limitações.

Fontes consultadas em 2026-11-02: URL da Suno fornecida pelo usuário (inacessível
neste ambiente); documentação oficial Playwright /docs/auth e Node /api/sqlite.html.

Nova tentativa em 2026-11-02, a pedido do usuário: executado
`npm run scrape -- --purpose start` em terminal interativo. Falhou antes do login.
A dependência libasound continua ausente no caminho padrão; mesmo fornecendo uma
biblioteca já disponível em /tmp, o Chromium com interface foi bloqueado por
`setsockopt: Operation not permitted`. Nenhum dado da conta foi coletado.

Diagnóstico atual (`npm run doctor`, 2026-11-02): Chromium continua bloqueado com
BROWSER_PERMISSION_DENIED, DNS da Suno falha com EAI_AGAIN/NETWORK_DNS_FAILED e o
utilitário secret-tool está ausente (KEYRING_TOOL_MISSING). O bloqueio do Chromium
é a causa imediata das falhas anteriores; o chaveiro ausente afeta a nova
persistência. Não foi possível validar integração real com navegador, Suno ou
chaveiro neste ambiente. Não contornar as restrições nem prometer funcionamento
completo após instalação de dependências: as rotas/seletores seguem não validados.

Comandos: `npm run login`, `npm run scrape -- --purpose start|rebalance`,
`npm run session:forget`, `npm run doctor`. `--no-session` mantém login manual sem
persistência. authenticatedSelector continua null, exigindo Enter para confirmar
Portfólio mesmo ao reutilizar sessão. Expiração local máxima de sete dias;
expiração/revogação da Suno pode ocorrer antes. Ver README para configurar chaveiro,
limites do estado filtrado e o diagnóstico. Nenhum commit, upload ou publicação.
