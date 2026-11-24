# Carteira BTG sob demanda

Fotografa as suas posições no BTG quando você for rebalancear. Não há
agendamento: roda só quando você chama.

```sh
npm run btg:carteira        # abre o Chrome, você faz login, a posição é gravada
npm run btg:carteira:ver    # mostra a última foto, sem abrir navegador
```

## Como funciona

1. Abre um Chrome com perfil descartável, em janela anônima, no login do BTG.
2. Você faz login e MFA manualmente. Nada de senha passa pelo terminal.
3. A página inicial do próprio app carrega a posição consolidada
   (`GET /investments/api/statement-position/allocation/{conta}/type/MARKET/summary`,
   mapeado em 2026-11-24). O script só **escuta** essa resposta: não envia
   requisições, não clica e não navega.
4. Grava a foto, imprime o resumo e fecha o Chrome, apagando o perfil temporário.
   A sessão do BTG não é salva.

Se a posição não carregar em 15 minutos (`--timeout-min N`) ou se o Chrome for
fechado antes, nada é gravado (código de saída 3). Foto com aviso sai com código 2.

## Banco: `privado/btg-carteira.sqlite`

| Tabela/visão | Conteúdo |
| --- | --- |
| `snapshots` | uma linha por coleta: data da posição, patrimônio total, avisos e o JSON da resposta (sem conta) |
| `class_totals` | total por classe: Conta Investimento, Valores em Trânsito, Renda Variável, Renda Fixa |
| `positions` | um ativo por linha: categoria (acao, fii, etf, CDB, LCA, LCI, TESOURO DIRETO…), ticker, ISIN, emissor, quantidade, preço, valor bruto/líquido, valor investido, preço médio, IR, IOF, emissão, vencimento, indexador e taxa |
| `latest_positions`, `latest_classes` | a última foto, com `pct_of_total` |

```sh
sqlite3 privado/btg-carteira.sqlite \
  "SELECT category, ticker, gross_value, pct_of_total FROM latest_positions ORDER BY gross_value DESC"
```

Número de conta, CPF, nome, contato, tokens e IDs de operação são removidos
antes de gravar. Valores e quantidades são gravados porque são o objetivo da
coleta; ficam só em `privado/`, fora do versionamento.

## Avisos

- `CLASS_NOT_PARSED`: apareceu uma classe com saldo (ex.: fundos, previdência)
  que o leitor ainda não conhece; só o total foi gravado. O JSON fica em
  `snapshots.raw_json` para ajustar o leitor.
- `CLASS_TOTAL_MISMATCH` / `TOTAL_MISMATCH`: a soma dos ativos não bate com o
  total informado pelo BTG.

## Se o BTG mudar

`npm run btg:carteira:mapear` abre o mesmo Chrome e grava em
`privado/run/btg-descoberta/` as respostas JSON (limpas) das páginas que você
abrir, para localizar o novo endpoint. Apague a pasta depois do ajuste.
