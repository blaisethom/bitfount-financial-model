import { loadInitialInput, EXPECTED_TOTALS } from './src/data';
import { computeModel } from './src/model';

const input = loadInitialInput();
const out = computeModel(input);

console.log('Per-TA totals (computed vs expected):');
let ok = true;
for (const ta of input.taNames) {
  const c = out.perTA[ta];
  const platform = c.platform.reduce((a, b) => a + b, 0);
  const project = c.project.reduce((a, b) => a + b, 0);
  const pm = c.pm.reduce((a, b) => a + b, 0);
  const total = platform + project + pm;
  const e = EXPECTED_TOTALS[ta];
  const diff = Math.abs(total - (e?.total ?? 0));
  const pass = diff < 1;
  if (!pass) ok = false;
  console.log(
    `  ${ta.padEnd(15)} platform=${fmt(platform)} project=${fmt(project)} pm=${fmt(pm)} total=${fmt(total)} expected=${fmt(e?.total ?? 0)} diff=${diff.toFixed(2)} ${pass ? 'OK' : 'FAIL'}`,
  );
}

console.log(`\nYears: ${out.years.join(', ')}`);
console.log('Yearly totals:');
for (let i = 0; i < out.years.length; i++) {
  console.log(`  ${out.years[i]}: ${fmt(out.yearly.totals.total[i])}`);
}
const grand = Object.values(EXPECTED_TOTALS).reduce((a: number, b) => a + (b?.total ?? 0), 0);
const computedGrand = out.totals.total.reduce((a, b) => a + b, 0);
console.log(`\nModeled-only total: computed=${fmt(computedGrand)} expected=${fmt(grand)} diff=${(computedGrand - grand).toFixed(2)}`);

const hubspotTotal = input.hubspot.grandTotal.reduce((a, b) => a + b, 0);
const grandTotal = computedGrand + hubspotTotal;
console.log(`HubSpot pipeline:   ${fmt(hubspotTotal)}`);
console.log(`GRAND TOTAL (HubSpot + modeled): ${fmt(grandTotal)}`);
console.log(`Excel reference (HubSpot Pivot grand: $1,746,721 + Revenue Model auto: $180,511,458) = $182,258,179`);

console.log('\n--- Employee costs ---');
const empTotal = out.employees.total.reduce((a, b) => a + b, 0);
console.log(`Total employee cost (6 yr): ${fmt(empTotal)}`);
console.log('By year:');
for (let i = 0; i < out.years.length; i++) {
  console.log(`  ${out.years[i]}: ${fmt(out.employees.yearly.total[i])}`);
}
console.log('By department (6-yr):');
for (const [dept, arr] of Object.entries(out.employees.perDepartment)) {
  const t = arr.reduce((a, b) => a + b, 0);
  console.log(`  ${dept.padEnd(20)} ${fmt(t)}`);
}

if (!ok) process.exit(1);

function fmt(x: number): string {
  return '$' + Math.round(x).toLocaleString();
}
