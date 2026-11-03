# Contexto deste projeto

Consultar Portfólio e Carteiras da Suno e coletar o catálogo de Produtos de
investimento do BTG, mantendo a origem de cada dado.
Somente consulta: nunca comprar, vender, enviar ordens, transferir recursos ou
alterar carteira/configurações. Distinguir posições pessoais de recomendações.
Registrar fontes, datas e incertezas. Não inventar saldos, cotações ou disponibilidade.

Manter contexto nesta pasta, sem memória ou skills globais. Dados financeiros
pessoais somente em `privado/`, fora do versionamento. Nunca gravar senhas,
códigos de autenticação, CPF ou números de conta. Por autorização explícita do
usuário em 2026-11-02, cookies e tokens necessários para reutilizar a sessão Suno
podem ser persistidos somente no cofre criptografado em `privado/auth/`, com chave
aleatória de 256 bits no chaveiro Linux Secret Service. Nunca salvar estado de
autenticação em texto aberto, no SQLite, em logs ou no versionamento. Não extrair
informações pessoais dos tokens. Login e MFA permanecem manuais; respeitar expiração
e revogação. Não usar um perfil completo persistente nem fallback sem criptografia.
No BTG, usar login manual e sessão temporária; a autorização de persistência
criptografada anterior é específica da Suno. Os objetivos de alocação fornecidos
pelo usuário ficam em privado/, separados de posições e recomendações.
Não enviar
dados privados a buscas, serviços adicionais ou agentes sem autorização específica.
Não fazer commit, push, publicação ou upload sem autorização explícita.
Solicitar o mínimo necessário; preferir identificadores a patrimônio. Não prometer
armazenamento exclusivamente local: há processamento e histórico de sessão do provedor.

Ao retomar, ler `CONTEXTO.md` e, quando necessário e autorizado, `privado/`.
