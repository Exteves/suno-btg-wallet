# Coleta diária Suno → base de conhecimento

Coleta **somente leitura** de Relatórios, Carteiras (cada carteira e suas abas),
Cobertura Suno e Nossos Fundos, uma vez por dia, em `privado/suno-conhecimento.sqlite`.

## Primeiro uso

```sh
npm run daily            # abre o navegador; faça login/MFA nele e pressione Enter
```

A sessão fica no cofre criptografado (`privado/auth/`, chave no Secret Service) e
é regravada a cada coleta bem-sucedida. Nas próximas execuções não há Enter: o
login é confirmado por uma resposta **autorizada** da API da Suno, não por cookie
ou rota. A primeira coleta percorre todo o histórico de relatórios; as seguintes
param assim que uma página só traz relatórios já conhecidos
(`npm run daily:full` refaz o percurso completo).

## Agendamento

`npm run schedule:install [-- HH:MM]` instala um timer systemd de usuário
(padrão 19:30, após o fechamento do mercado). `Persistent=true`: se o WSL estava
desligado no horário, a coleta roda quando ele for iniciado. Requer o WSLg, porque
o Cloudflare da Suno bloqueia o Chromium headless (verificado em 2026-11-23); uma
janela do navegador abre durante a coleta.

```sh
systemctl --user list-timers suno-daily.timer
journalctl --user -u suno-daily -n 100       # log da última execução
systemctl --user start suno-daily             # rodar agora
systemctl --user disable --now suno-daily.timer
```

Códigos de saída: 0 completo, 2 parcial (dados gravados com avisos), 3 login
necessário (rode `npm run daily` num terminal), 4 outra coleta em andamento, 1 falha.
O chaveiro precisa estar desbloqueado na sessão Linux.

## Como os dados são obtidos

O site é uma SPA que lê `membros-api-gateway.suno.com.br/api/`. O coletor navega
pelas páginas e grava as respostas JSON que a própria página carrega, filtradas
por uma lista de endpoints de conteúdo (`src/suno-kb/endpoints.js`). Paginação:
repete o mesmo GET mudando apenas `page`/`offset`, com cabeçalhos mantidos só em
memória e 0,8 s entre chamadas. Endpoints pessoais (Meus Investimentos,
patrimônio, transações, perfil, corretoras) **nunca são gravados**; só o formato
do caminho vai para `endpoint_inventory`. POST/PUT/DELETE são bloqueados, exceto
a renovação de token da própria aplicação. Abas com rótulos de ação (comprar,
investir…) e links fora das quatro seções não são acionados.

### Comportamentos verificados na Suno (2026-11-23)

- O app só renderiza as carteiras se o POST `v1/user/show-update-cpf` (consulta de
  um flag, sem alteração de conta) passar; sem ele toda rota cai em `/error`. É o
  único POST liberado além da renovação de token.
- `/relatorios` lista via `v2/search` (só `report.list` é gravado; notícias não).
- Eventos das carteiras: a API ignora `page` a partir da 2ª página, mas aceita
  `limit`; o coletor pede tudo de uma vez quando o total anunciado (`count`) não
  fecha. A cobertura (base 1) recusa `limit` grande (HTTP 400) e é paginada.
- Carteiras fora da assinatura respondem `has_access:false` com lista vazia
  (hoje: ETFs internacionais, Internacional, Small Caps).
- `PAGINATION_INCOMPLETE` indica lista diária com menos itens que o total da API.

Opções: `--wait-login N` espera o login na janela sem terminal interativo;
`npm run daily:reindex` recalcula itens/observações a partir das respostas brutas.

## Tabelas e views

| Objeto | Conteúdo |
| --- | --- |
| `runs` | uma linha por execução, `collection_date` no fuso de São Paulo |
| `responses` + `blobs` | cada resposta JSON bruta (sem dados pessoais conhecidos), deduplicada por hash |
| `items` / `item_revisions` | catálogo cumulativo: primeira/última vez visto, cada versão |
| `observations` | estado diário de listas (carteiras, cobertura, fundos) |
| `reports` | relatórios acumulados |
| `wallet_positions`, `coverage_daily`, `funds_daily` | estado de cada dia (última execução do dia) |
| `composition_changes` | ativos que entraram/saíram entre dias coletados |
| `pages`, `page_texts` | rotas visitadas e texto renderizado |
| `issues`, `endpoint_inventory` | avisos e endpoints não gravados |

```sql
SELECT collection_date, scope_key, ticker, json_extract(data_json, '$.precoTeto')
FROM wallet_positions ORDER BY collection_date DESC, scope_key, item_index;

SELECT * FROM composition_changes ORDER BY collection_date DESC;
SELECT title, published, first_seen_at FROM reports ORDER BY first_seen_at DESC LIMIT 20;
```

## Limites conhecidos

- O JSON é sempre guardado inteiro; `ticker`/`title` são extraídos por
  heurística (renda fixa não tem ticker). Ao mudar a heurística, rode `daily:reindex`.
- O conteúdo integral dos relatórios (leitor/PDF) ainda não é baixado; só a lista
  e seus metadados.
- Carteiras sem assinatura podem redirecionar (`PAGE_REDIRECTED`).
- Valores ficam como a API envia; nada é convertido ou inventado.
