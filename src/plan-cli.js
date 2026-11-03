import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { Store } from './database.js';
import { privatePath } from './privacy.js';
import { savePlan } from './allocation.js';

process.umask(0o077);
let store;
try {
  const { values } = parseArgs({ options: {
    input: { type: 'string', default: 'privado/plano-carteira.json' },
    db: { type: 'string', default: 'privado/suno.sqlite' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) console.log('npm run wallet:plan -- --input privado/plano-carteira.json --db privado/suno.sqlite');
  else {
    const input = JSON.parse(await readFile(privatePath(values.input), 'utf8'));
    store = new Store(privatePath(values.db));
    const id = savePlan(store, input);
    console.log(JSON.stringify({ planId: id, status: 'saved', source: 'user_defined_target' }));
  }
} catch {
  console.error('Não foi possível registrar o plano. Verifique os arquivos em privado/, os percentuais e as permissões. Dados financeiros não foram impressos.');
  process.exitCode = 1;
} finally { store?.close(); }
