import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { createScratch } from '../../tools/test-paths.mjs';
import { parseImportSource, type ParsedTable } from '../../src/main/services/importer';
import { parsePlcReference } from '../../src/domain/address';
import { buildImportPlan, type RegisterImportRow } from '../../src/domain/import-plan';
import { mutateWorkspace } from '../../src/domain/workspace-mutations';
import { templateWorkspace } from '../support/template-workspace';

function plan(table: ParsedTable, prefix: string) {
  const column = (name: string) => table.columns.indexOf(name);
  const rows: RegisterImportRow[] = table.rows.map((values) => {
    const address = parsePlcReference(values[column('Address')] ?? '');
    if (!address) throw new Error('Expected a PLC address in the file');
    return {
      ...address,
      name: values[column('Name')] ?? '',
      type: values[column('Type')] ?? '',
      access: values[column('Access')] ?? '',
      unit: values[column('Unit')] ?? '',
      scale: values[column('Scale')] ?? '',
      offset: values[column('Offset')] ?? '',
    };
  });
  return buildImportPlan(rows, 'auto', prefix);
}

it('parses real XLSX and JSON files into zero-based blocks, and rejects import overlap atomically', async () => {
  const dir = createScratch('import-files-');
  const xlsx = path.join(dir, 'registers.xlsx');
  const json = path.join(dir, 'registers.json');
  const overlap = path.join(dir, 'overlap.json');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Registers');
  sheet.addRow(['Address', 'Name', 'Type', 'Access', 'Unit', 'Scale', 'Offset']);
  sheet.addRow(['40201', 'ExcelUInt', 'UInt16', 'RW', 'rpm', '0.5', '2']);
  sheet.addRow(['40203', 'ExcelWide', 'Float32', 'R', 'V', '1', '0']);
  await workbook.xlsx.writeFile(xlsx);
  fs.writeFileSync(json, JSON.stringify([{ Address: '30051', Name: 'JsonInput', Type: 'Float64', Access: 'RW', Unit: 'Hz', Scale: '1.25', Offset: '-3' }]));
  fs.writeFileSync(overlap, JSON.stringify([{ Address: '40001', Name: 'Overlap', Type: 'UInt16', Access: 'R', Unit: '', Scale: '1', Offset: '0' }]));

  const xlsxPlan = plan(await parseImportSource({ kind: 'file', path: xlsx }), 'xlsx');
  expect(xlsxPlan.blocks.map(block => [block.area, block.start, block.length])).toEqual([[3, 200, 4]]);
  expect(xlsxPlan.points.map(point => [point.mapping.rawType, point.mapping.offset, point.mapping.registerCount])).toEqual([
    ['UInt16', 0, 1], ['Float32', 2, 2],
  ]);
  expect([xlsxPlan.points[0]?.scale, xlsxPlan.points[0]?.offset]).toEqual([0.5, 2]);

  const jsonPlan = plan(await parseImportSource({ kind: 'file', path: json }), 'json');
  expect(jsonPlan.blocks.map(block => [block.area, block.start, block.length])).toEqual([[4, 50, 4]]);
  expect(jsonPlan.points[0]).toMatchObject({ access: 'ro', mapping: { rawType: 'Float64', offset: 0, registerCount: 4 } });

  const initial = templateWorkspace();
  const imported = mutateWorkspace(initial, { type: 'template.importContent', templateId: 't1', blocks: [...xlsxPlan.blocks, ...jsonPlan.blocks], points: [...xlsxPlan.points, ...jsonPlan.points] });
  expect(imported.templates[0]?.blocks).toHaveLength(initial.templates[0]!.blocks.length + 2);
  const overlapping = plan(await parseImportSource({ kind: 'file', path: overlap }), 'overlap');
  expect(() => mutateWorkspace(imported, { type: 'template.importContent', templateId: 't1', ...overlapping })).toThrow();
  expect(imported.templates[0]?.blocks).toHaveLength(initial.templates[0]!.blocks.length + 2);
});
