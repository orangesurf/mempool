import { Transaction } from '@interfaces/electrs.interface';
import { DerivedAddress } from './watch.types';
import { computeBalance, computeLastUsed, computeUtxos, netValue } from './wallet-math';

/**
 * The wallet math decides what balance a user is shown. These fixtures cover the cases that
 * actually break naive implementations: change outputs (which must not be counted as
 * "received"), spends (which must remove UTXOs), and unconfirmed sends (whose pending value
 * is negative and must not be double-counted against the confirmed balance).
 */

const MINE_RECV_0 = 'bc1qmine-recv-0';
const MINE_RECV_1 = 'bc1qmine-recv-1';
const MINE_CHANGE_0 = 'bc1qmine-change-0';
const THEIRS = 'bc1qsomeone-else';

function addressMap(): Map<string, DerivedAddress> {
  return new Map<string, DerivedAddress>([
    [MINE_RECV_0, { address: MINE_RECV_0, chain: 0, index: 0 }],
    [MINE_RECV_1, { address: MINE_RECV_1, chain: 0, index: 1 }],
    [MINE_CHANGE_0, { address: MINE_CHANGE_0, chain: 1, index: 0 }],
  ]);
}

function tx(opts: {
  txid: string;
  confirmed?: boolean;
  height?: number;
  vin?: { txid: string; vout: number; address?: string; value?: number }[];
  vout?: { address?: string; value: number }[];
}): Transaction {
  return {
    txid: opts.txid,
    vin: (opts.vin || []).map((v) => ({
      txid: v.txid,
      vout: v.vout,
      prevout: v.address ? { scriptpubkey_address: v.address, value: v.value } : null,
    })),
    vout: (opts.vout || []).map((v) => ({
      scriptpubkey_address: v.address,
      value: v.value,
    })),
    status: {
      confirmed: opts.confirmed !== false,
      block_height: opts.height,
    },
  } as unknown as Transaction;
}

describe('wallet-math', () => {
  describe('computeUtxos', () => {
    it('counts an output paying us as a UTXO', () => {
      const txs = [tx({ txid: 'a', height: 100, vout: [{ address: MINE_RECV_0, value: 50_000 }] })];
      const utxos = computeUtxos(txs, addressMap());
      expect(utxos.length).toBe(1);
      expect(utxos[0].value).toBe(50_000);
      expect(utxos[0].address).toBe(MINE_RECV_0);
    });

    it('ignores outputs that are not ours', () => {
      const txs = [tx({ txid: 'a', height: 100, vout: [{ address: THEIRS, value: 50_000 }] })];
      expect(computeUtxos(txs, addressMap()).length).toBe(0);
    });

    it('removes a UTXO once we spend it', () => {
      const txs = [
        tx({ txid: 'a', height: 100, vout: [{ address: MINE_RECV_0, value: 50_000 }] }),
        tx({
          txid: 'b',
          height: 101,
          vin: [{ txid: 'a', vout: 0, address: MINE_RECV_0, value: 50_000 }],
          vout: [{ address: THEIRS, value: 49_000 }],
        }),
      ];
      expect(computeUtxos(txs, addressMap()).length).toBe(0);
    });

    it('is order-independent (spend seen before the funding tx)', () => {
      const funding = tx({ txid: 'a', height: 100, vout: [{ address: MINE_RECV_0, value: 50_000 }] });
      const spend = tx({
        txid: 'b',
        height: 101,
        vin: [{ txid: 'a', vout: 0, address: MINE_RECV_0, value: 50_000 }],
        vout: [{ address: THEIRS, value: 49_000 }],
      });
      expect(computeUtxos([spend, funding], addressMap()).length).toBe(0);
    });

    it('keeps the change output of our own spend', () => {
      const txs = [
        tx({ txid: 'a', height: 100, vout: [{ address: MINE_RECV_0, value: 100_000 }] }),
        tx({
          txid: 'b',
          height: 101,
          vin: [{ txid: 'a', vout: 0, address: MINE_RECV_0, value: 100_000 }],
          vout: [
            { address: THEIRS, value: 60_000 },
            { address: MINE_CHANGE_0, value: 39_000 }, // 1000 sat fee
          ],
        }),
      ];
      const utxos = computeUtxos(txs, addressMap());
      expect(utxos.length).toBe(1);
      expect(utxos[0].address).toBe(MINE_CHANGE_0);
      expect(utxos[0].value).toBe(39_000);
    });
  });

  describe('netValue', () => {
    it('is positive for a receive', () => {
      const t = tx({ txid: 'a', vout: [{ address: MINE_RECV_0, value: 50_000 }] });
      expect(netValue(t, addressMap())).toBe(50_000);
    });

    it('is negative for a send, and includes the fee', () => {
      // We spend 100k, send 60k away, get 39k change back. Fee is 1k.
      // Net effect on us: -(100k) + 39k = -61k, i.e. the 60k paid plus the 1k fee.
      const t = tx({
        txid: 'b',
        vin: [{ txid: 'a', vout: 0, address: MINE_RECV_0, value: 100_000 }],
        vout: [
          { address: THEIRS, value: 60_000 },
          { address: MINE_CHANGE_0, value: 39_000 },
        ],
      });
      expect(netValue(t, addressMap())).toBe(-61_000);
    });

    it('is just the fee for a self-transfer', () => {
      const t = tx({
        txid: 'b',
        vin: [{ txid: 'a', vout: 0, address: MINE_RECV_0, value: 100_000 }],
        vout: [{ address: MINE_RECV_1, value: 99_000 }],
      });
      expect(netValue(t, addressMap())).toBe(-1_000);
    });
  });

  describe('computeBalance', () => {
    it('sums confirmed UTXOs', () => {
      const txs = [
        tx({ txid: 'a', height: 100, vout: [{ address: MINE_RECV_0, value: 50_000 }] }),
        tx({ txid: 'b', height: 101, vout: [{ address: MINE_RECV_1, value: 25_000 }] }),
      ];
      const map = addressMap();
      const balance = computeBalance(computeUtxos(txs, map), txs, map);
      expect(balance.confirmed).toBe(75_000);
      expect(balance.pending).toBe(0);
      expect(balance.total).toBe(75_000);
    });

    it('reports an incoming unconfirmed payment as positive pending', () => {
      const txs = [
        tx({ txid: 'a', height: 100, vout: [{ address: MINE_RECV_0, value: 50_000 }] }),
        tx({ txid: 'b', confirmed: false, vout: [{ address: MINE_RECV_1, value: 10_000 }] }),
      ];
      const map = addressMap();
      const balance = computeBalance(computeUtxos(txs, map), txs, map);
      expect(balance.confirmed).toBe(50_000);
      expect(balance.pending).toBe(10_000);
      expect(balance.total).toBe(60_000);
    });

    it('reports an outgoing unconfirmed payment as negative pending, without double-counting', () => {
      const txs = [
        tx({ txid: 'a', height: 100, vout: [{ address: MINE_RECV_0, value: 100_000 }] }),
        tx({
          txid: 'b',
          confirmed: false,
          vin: [{ txid: 'a', vout: 0, address: MINE_RECV_0, value: 100_000 }],
          vout: [
            { address: THEIRS, value: 60_000 },
            { address: MINE_CHANGE_0, value: 39_000 },
          ],
        }),
      ];
      const map = addressMap();
      const balance = computeBalance(computeUtxos(txs, map), txs, map);
      // The 100k UTXO is spent (so not confirmed-unspent), the 39k change is unconfirmed.
      expect(balance.confirmed).toBe(0);
      expect(balance.pending).toBe(-61_000);
      // Spendable-once-settled: we started with 100k and are paying 61k away.
      expect(balance.total).toBe(-61_000);
    });
  });

  describe('computeLastUsed', () => {
    it('returns -1 for an untouched chain', () => {
      const lastUsed = computeLastUsed([], addressMap());
      expect(lastUsed[0]).toBe(-1);
      expect(lastUsed[1]).toBe(-1);
    });

    it('tracks the highest used index per chain, from outputs and inputs alike', () => {
      const txs = [
        tx({ txid: 'a', height: 100, vout: [{ address: MINE_RECV_1, value: 10 }] }),
        tx({
          txid: 'b',
          height: 101,
          vin: [{ txid: 'a', vout: 0, address: MINE_CHANGE_0, value: 10 }],
          vout: [{ address: THEIRS, value: 5 }],
        }),
      ];
      const lastUsed = computeLastUsed(txs, addressMap());
      expect(lastUsed[0]).toBe(1); // MINE_RECV_1 is receive index 1
      expect(lastUsed[1]).toBe(0); // MINE_CHANGE_0 is change index 0, seen as an input
    });
  });
});
