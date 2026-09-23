import { parseJsonl, parseLabelFile, toJsonl } from './wallet-label-file.utils';

describe('wallet label files', () => {
  it('round-trips JSONL with last-writer-wins semantics', () => {
    const imported = parseJsonl([
      '{"type":"tx","ref":"abc","label":"first"}',
      '{"type":"output","ref":"abc:0","label":"coin"}',
      '{"type":"tx","ref":"abc","label":"last"}',
    ].join('\n'));

    expect(imported).toEqual({ records: [
      { type: 'tx', ref: 'abc', label: 'last' },
      { type: 'output', ref: 'abc:0', label: 'coin' },
    ], skipped: 0 });
    expect(parseJsonl(toJsonl(imported.records))).toEqual(imported);
  });

  it('imports supported labels from a complete Sparrow BIP-329 export', () => {
    expect(parseJsonl([
      '{"type":"xpub","ref":"xpub-example","label":"Wallet"}',
      '{"type":"tx","ref":"abc"}',
      '{"type":"addr","ref":"bc1qexample","label":"Savings"}',
      '{"type":"input","ref":"abc:0","label":"Spent coin"}',
      '{"type":"output","ref":"abc:1","label":"Change"}',
      '{"type":"spscan","ref":"sp1qexample","label":"Silent payments"}',
    ].join('\n'))).toEqual({
      records: [
        { type: 'addr', ref: 'bc1qexample', label: 'Savings' },
        { type: 'output', ref: 'abc:1', label: 'Change' },
      ],
      skipped: 4,
    });
  });

  it('imports transaction labels from Sparrow CSV exports with or without fiat values', () => {
    const firstTxid = 'a'.repeat(64);
    const secondTxid = 'b'.repeat(64);

    expect(parseLabelFile([
      'Date (UTC),Label,Value,Balance,Fee,Txid',
      `2025-02-20 13:33:28,"Savings, long term",1304,1304,,${firstTxid}`,
      `2025-02-20 13:35:41,,-1304,0,872,${secondTxid}`,
    ].join('\r\n'), 'transactions.csv')).toEqual({
      format: 'sparrow-transactions-csv',
      records: [{ type: 'tx', ref: firstTxid, label: 'Savings, long term' }],
      skipped: 1,
    });

    expect(parseLabelFile([
      'Date (UTC),Label,Value,Balance,Fee,Value (USD),Txid',
      `2025-10-13 22:40:14,"Invoice ""October""",37443,37443,,43.38,${secondTxid}`,
      '# Historical USD values are approximate.,,,,,,',
    ].join('\n'), 'transactions.csv')).toEqual({
      format: 'sparrow-transactions-csv',
      records: [{ type: 'tx', ref: secondTxid, label: 'Invoice "October"' }],
      skipped: 1,
    });
  });

  it('detects BIP-329 JSONL label files independently of their filename', () => {
    expect(parseLabelFile('\uFEFF{"type":"tx","ref":"abc","label":"Payment"}', 'labels.txt'))
      .toEqual({
        format: 'bip329',
        records: [{ type: 'tx', ref: 'abc', label: 'Payment' }],
        skipped: 0,
      });
  });

  it('rejects malformed CSV and invalid JSONL without partially importing labels', () => {
    expect(() => parseLabelFile('Label,Txid\n"unclosed', 'labels.csv')).toThrowError(/not closed/);
    expect(() => parseJsonl('{"type":"tx","ref":"abc","label":"ok"}\n{')).toThrowError(/line 2/);
  });
});
