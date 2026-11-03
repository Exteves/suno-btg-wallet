import { createHash } from 'node:crypto';
import { scrubObject } from './privacy.js';

export function allocate(input) {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.currency !== 'BRL'
    || !Number.isSafeInteger(input.capital_cents) || input.capital_cents <= 0
    || !Array.isArray(input.targets) || !input.targets.length || input.targets.length > 20
    || typeof input.source_note !== 'string') throw new Error('Plano de alocação inválido.');
  const seen = new Set();
  let weights = 0;
  for (const target of input.targets) {
    if (!/^[a-z_]+$/.test(target.asset_class) || seen.has(target.asset_class)
      || !Number.isInteger(target.weight_basis_points) || target.weight_basis_points < 0 || target.weight_basis_points > 10000) throw new Error('Classe ou percentual inválido.');
    weights += target.weight_basis_points;
    seen.add(target.asset_class);
  }
  if (weights !== 10000) throw new Error('Os percentuais devem somar 100%.');
  const capital = BigInt(input.capital_cents);
  const targets = input.targets.map((target, index) => {
    const numerator = capital * BigInt(target.weight_basis_points);
    return { ...target, amount_cents: Number(numerator / 10000n), remainder: Number(numerator % 10000n), index };
  });
  const difference = input.capital_cents - targets.reduce((sum, target) => sum + target.amount_cents, 0);
  const ranked = [...targets].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < difference; index++) ranked[index].amount_cents++;
  return scrubObject({ name: input.name, capital_cents: input.capital_cents, currency: input.currency,
    source_note: input.source_note, targets: targets.map(({ asset_class, weight_basis_points, amount_cents }) => ({ asset_class, weight_basis_points, amount_cents })) });
}

export function savePlan(store, input) {
  const plan = allocate(input);
  const hash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  const db = store.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT id FROM allocation_plans WHERE definition_hash=?').get(hash);
    if (existing) { db.exec('COMMIT'); return Number(existing.id); }
    const id = Number(db.prepare('INSERT INTO allocation_plans(name,created_at,capital_cents,currency,source_note,definition_hash) VALUES(?,?,?,?,?,?)')
      .run(plan.name, new Date().toISOString(), plan.capital_cents, plan.currency, plan.source_note, hash).lastInsertRowid);
    const statement = db.prepare('INSERT INTO allocation_targets(plan_id,asset_class,weight_basis_points,amount_cents) VALUES(?,?,?,?)');
    for (const target of plan.targets) statement.run(id, target.asset_class, target.weight_basis_points, target.amount_cents);
    db.exec('COMMIT');
    return id;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
