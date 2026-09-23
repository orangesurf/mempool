import { Bip329Label, Bip329LabelType } from './watch.types';

const LABEL_TYPES = new Set<Bip329LabelType>(['tx', 'addr', 'output']);
const BIP329_TYPES = new Set(['tx', 'addr', 'pubkey', 'input', 'output', 'xpub', 'spscan']);

export interface Bip329ImportResult {
  records: Bip329Label[];
  skipped: number;
}

export type LabelImportFormat = 'bip329' | 'sparrow-transactions-csv';

export interface LabelFileImportResult extends Bip329ImportResult {
  format: LabelImportFormat;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell.length === 0) {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }

  if (quoted) {
    throw new Error('Invalid CSV label file: a quoted field is not closed.');
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function parseJsonl(text: string): Bip329ImportResult {
  const lastByRef = new Map<string, Bip329Label>();
  let skipped = 0;
  const lines = text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
  lines.forEach((line, index) => {
    if (!line.trim()) {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error('Invalid JSON on label line ' + (index + 1) + '.');
    }
    if (!value || typeof value !== 'object') {
      throw new Error('Invalid BIP-329 label on line ' + (index + 1) + '.');
    }
    const record = value as { type?: unknown; ref?: unknown; label?: unknown };
    if (typeof record.type !== 'string' || !BIP329_TYPES.has(record.type)
        || typeof record.ref !== 'string' || !record.ref
        || (record.label !== undefined && typeof record.label !== 'string')) {
      throw new Error('Invalid BIP-329 label on line ' + (index + 1) + '.');
    }
    if (!LABEL_TYPES.has(record.type as Bip329LabelType) || record.label === undefined) {
      skipped++;
      return;
    }
    const label = record.label;
    if (typeof label !== 'string') {
      throw new Error('Invalid BIP-329 label on line ' + (index + 1) + '.');
    }
    const type = record.type as Bip329LabelType;
    lastByRef.set(recordKey(type, record.ref), {
      type,
      ref: record.ref,
      label,
    });
  });
  return { records: [...lastByRef.values()], skipped };
}

export function parseSparrowTransactionsCsv(text: string): Bip329ImportResult {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ''));
  if (!rows.length) {
    throw new Error('The Sparrow transaction CSV is empty.');
  }

  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const labelColumn = headers.indexOf('label');
  const txidColumn = headers.findIndex((header) => header === 'txid' || header === 'transaction id');
  if (labelColumn === -1 || txidColumn === -1) {
    throw new Error('Unrecognised label file. Choose a BIP-329 JSONL or Sparrow transaction CSV file.');
  }

  const lastByRef = new Map<string, Bip329Label>();
  let skipped = 0;
  rows.slice(1).forEach((row, index) => {
    if (row.every((cell) => !cell.trim())) {
      return;
    }
    const label = (row[labelColumn] ?? '').trim();
    if (!label) {
      skipped++;
      return;
    }
    const ref = (row[txidColumn] ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(ref)) {
      throw new Error('Invalid transaction id in Sparrow CSV row ' + (index + 2) + '.');
    }
    lastByRef.set(recordKey('tx', ref), { type: 'tx', ref, label });
  });
  return { records: [...lastByRef.values()], skipped };
}

export function parseLabelFile(text: string, filename = ''): LabelFileImportResult {
  const lowerName = filename.toLowerCase();
  const jsonl = lowerName.endsWith('.jsonl') || lowerName.endsWith('.json')
    || text.replace(/^\uFEFF/, '').trimStart().startsWith('{');
  const result = jsonl ? parseJsonl(text) : parseSparrowTransactionsCsv(text);
  return {
    ...result,
    format: jsonl ? 'bip329' : 'sparrow-transactions-csv',
  };
}

export function toJsonl(records: Bip329Label[]): string {
  return records.map(({ type, ref, label }) => JSON.stringify({ type, ref, label })).join('\n');
}

function recordKey(type: Bip329LabelType, ref: string): string { return type + ':' + ref; }
