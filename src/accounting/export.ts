import { csvLine } from '../verticals/import/csv';
import {
  type AgingReport,
  type BalanceSheet,
  type CashFlow,
  type EquityStatement,
  type ProfitAndLoss,
  type TrialBalanceRow,
  type VatReturn,
} from './reports';

/**
 * CSV rendering for the financial statements. Every amount is already a fixed-scale money string,
 * so the exported file carries the exact ledger value and opens cleanly in a spreadsheet.
 */

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

export function toCsv(table: CsvTable): string {
  const lines = [csvLine(table.headers), ...table.rows.map((row) => csvLine(row))];
  return `${lines.join('\r\n')}\r\n`;
}

function moneyCell(value: { toFixed(scale: number): string }): string {
  return value.toFixed(4);
}

export function trialBalanceCsv(rows: readonly TrialBalanceRow[]): CsvTable {
  return {
    headers: ['Code', 'Account', 'Type', 'Section', 'Opening', 'Debit', 'Credit', 'Closing'],
    rows: rows.map((row) => [
      row.code,
      row.name,
      row.accountType,
      row.section,
      moneyCell(row.opening),
      moneyCell(row.debit),
      moneyCell(row.credit),
      moneyCell(row.closing),
    ]),
  };
}

export function profitAndLossCsv(report: ProfitAndLoss): CsvTable {
  const rows: string[][] = [];
  const section = (label: string, lines: typeof report.revenue) => {
    for (const line of lines) rows.push([label, line.code ?? '', line.name, moneyCell(line.amount)]);
  };
  section('Revenue', report.revenue);
  section('Cost of sales', report.costOfSales);
  section('Operating expenses', report.operatingExpenses);
  rows.push(['Total', '', 'Total revenue', moneyCell(report.totalRevenue)]);
  rows.push(['Total', '', 'Gross profit', moneyCell(report.grossProfit)]);
  rows.push(['Total', '', 'Total operating expenses', moneyCell(report.totalOperatingExpenses)]);
  rows.push(['Total', '', 'Net profit', moneyCell(report.netProfit)]);
  return { headers: ['Section', 'Code', 'Account', 'Amount'], rows };
}

export function balanceSheetCsv(report: BalanceSheet): CsvTable {
  const rows: string[][] = [];
  const push = (section: string, lines: typeof report.equity) => {
    for (const line of lines) rows.push([section, line.code ?? '', line.name, moneyCell(line.amount)]);
  };
  push('Current assets', report.assets.current);
  push('Non-current assets', report.assets.nonCurrent);
  rows.push(['Total', '', 'Total assets', moneyCell(report.totalAssets)]);
  push('Current liabilities', report.liabilities.current);
  push('Non-current liabilities', report.liabilities.nonCurrent);
  rows.push(['Total', '', 'Total liabilities', moneyCell(report.totalLiabilities)]);
  push('Equity', report.equity);
  rows.push(['Total', '', 'Total equity', moneyCell(report.totalEquity)]);
  return { headers: ['Section', 'Code', 'Account', 'Amount'], rows };
}

export function equityCsv(report: EquityStatement): CsvTable {
  const rows = report.rows.map((row) => [
    row.kind,
    row.code ?? '',
    row.name,
    moneyCell(row.opening),
    moneyCell(row.movement),
    moneyCell(row.closing),
  ]);
  rows.push([
    'total',
    '',
    'Total equity',
    moneyCell(report.openingEquity),
    moneyCell(report.otherMovements.plus(report.profitForPeriod)),
    moneyCell(report.closingEquity),
  ]);
  return { headers: ['Kind', 'Code', 'Account', 'Opening', 'Movement', 'Closing'], rows };
}

export function cashFlowCsv(report: CashFlow): CsvTable {
  const rows = report.rows.map((row) => [
    row.activity,
    row.code ?? '',
    row.name,
    moneyCell(row.amount),
  ]);
  rows.push(['total', '', 'Operating', moneyCell(report.operating)]);
  rows.push(['total', '', 'Investing', moneyCell(report.investing)]);
  rows.push(['total', '', 'Financing', moneyCell(report.financing)]);
  rows.push(['total', '', 'Net change in cash', moneyCell(report.netChange)]);
  return { headers: ['Activity', 'Code', 'Line', 'Amount'], rows };
}

export function agingCsv(report: AgingReport): CsvTable {
  const rows = report.rows.map((row) => [
    row.contactName,
    moneyCell(row.current),
    moneyCell(row.days1To30),
    moneyCell(row.days31To60),
    moneyCell(row.days61To90),
    moneyCell(row.over90),
    moneyCell(row.total),
  ]);
  rows.push([
    report.totals.contactName,
    moneyCell(report.totals.current),
    moneyCell(report.totals.days1To30),
    moneyCell(report.totals.days31To60),
    moneyCell(report.totals.days61To90),
    moneyCell(report.totals.over90),
    moneyCell(report.totals.total),
  ]);
  return {
    headers: ['Contact', 'Current', '1-30', '31-60', '61-90', '90+', 'Total'],
    rows,
  };
}

export function vatCsv(report: VatReturn): CsvTable {
  const rows = report.rows.map((row) => [
    row.bucket,
    `${row.taxRate.times(100).toFixed(2)}%`,
    moneyCell(row.net),
    moneyCell(row.tax),
    moneyCell(row.gross),
  ]);
  rows.push(['total', '', '', moneyCell(report.outputVat), 'output VAT']);
  rows.push(['total', '', '', moneyCell(report.inputVat), 'input VAT']);
  rows.push(['total', '', '', moneyCell(report.netVat), 'net VAT']);
  return { headers: ['Bucket', 'Rate', 'Net', 'VAT', 'Gross'], rows };
}
