export interface ParsedTable {
  columns: string[];
  rows: string[][];
  sourceLabel: string;
}

function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const candidates = ['\t', ',', ';'];
  let best = ',';
  let bestCount = 0;
  for (const c of candidates) {
    const n = first.split(c).length - 1;
    if (n > bestCount) {
      bestCount = n;
      best = c;
    }
  }
  return best;
}

export function parseDelimited(text: string, sourceLabel: string): ParsedTable {
  const delim = detectDelimiter(text);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return { columns: [], rows: [], sourceLabel };
  const columns = splitCsvLine(lines[0] as string, delim).map((c, i) => c.trim() || `col${i + 1}`);
  const rows = lines.slice(1).map((l) => splitCsvLine(l, delim));
  return { columns, rows, sourceLabel };
}

export function parseJsonTable(text: string, sourceLabel: string): ParsedTable {
  const data = JSON.parse(text) as unknown;
  const arr = Array.isArray(data) ? data : Array.isArray((data as { rows?: unknown[] }).rows) ? ((data as { rows: unknown[] }).rows as unknown[]) : null;
  if (!arr) throw new Error('JSON 必须是对象数组或包含 rows 数组');
  const columns: string[] = [];
  for (const item of arr) {
    if (item && typeof item === 'object') {
      for (const key of Object.keys(item as Record<string, unknown>)) if (!columns.includes(key)) columns.push(key);
    }
  }
  const rows = arr.map((item) => {
    const obj = (item ?? {}) as Record<string, unknown>;
    return columns.map((c) => {
      const v = obj[c];
      return v === undefined || v === null ? '' : String(v);
    });
  });
  return { columns, rows, sourceLabel };
}

export async function parseXlsx(filePath: string): Promise<ParsedTable> {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error('工作簿没有工作表');
  const matrix: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = cell.text ?? String(cell.value ?? '');
    });
    matrix.push(cells);
  });
  if (!matrix.length) return { columns: [], rows: [], sourceLabel: filePath };
  const columns = (matrix[0] as string[]).map((c, i) => (c || '').trim() || `col${i + 1}`);
  return { columns, rows: matrix.slice(1), sourceLabel: filePath };
}

export async function parseImportSource(source: { kind: 'text'; text: string; format: 'csv' | 'json' | 'clipboard' } | { kind: 'file'; path: string }): Promise<ParsedTable> {
  if (source.kind === 'text') {
    if (source.format === 'json') return parseJsonTable(source.text, 'clipboard/json');
    return parseDelimited(source.text, source.format === 'clipboard' ? '剪贴板' : 'csv');
  }
  if (/\.xlsx$/i.test(source.path)) return parseXlsx(source.path);
  const fs = await import('node:fs');
  const text = fs.readFileSync(source.path, 'utf-8');
  if (/\.json$/i.test(source.path)) return parseJsonTable(text, source.path);
  return parseDelimited(text, source.path);
}