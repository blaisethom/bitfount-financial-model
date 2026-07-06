import { resolveReport } from './resolveReport';
import type { ReportDef } from './types';
import cashflowReportYaml from './cashflow_report.yaml';

export const cashflowReport: ReportDef = resolveReport(cashflowReportYaml);
