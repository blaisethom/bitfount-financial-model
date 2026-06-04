// Engine-driven Excel download. Mirrors `downloadModelAsExcel` from the
// legacy exporter but pipes the data through evaluateSalesModel +
// renderReportToWorkbook so the report layout is fully declarative.

import ExcelJS from 'exceljs';
import type { ModelInput } from '../types';
import { salesModel } from '../models/salesModel';
import { evaluateSalesModel } from '../models/evaluateSalesModel';
import { renderReportToWorkbook } from './excelRenderer';
import { salesReport } from './salesReport';

export async function downloadModelAsExcelViaEngine(input: ModelInput): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Bitfount Sales Model (engine)';
  wb.created = new Date();

  const evalResult = evaluateSalesModel(input);
  renderReportToWorkbook(wb, salesModel, evalResult, salesReport);

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  a.download = `bitfount-sales-model-engine-${stamp}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
