import { loadInitialInput } from '../src/data.js';
import { evaluateSalesModel } from '../src/models/evaluateSalesModel.js';
const r = evaluateSalesModel(loadInitialInput());
const out: Record<string, unknown[]> = {};
for (const [k, t] of Object.entries(r.tables)) {
  out[k] = t.rows;
}
process.stdout.write(JSON.stringify(out));
