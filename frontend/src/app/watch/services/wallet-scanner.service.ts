import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ElectrsApiService } from '@app/services/electrs-api.service';
import { Transaction } from '@interfaces/electrs.interface';
import { Chain, DerivedAddress, WatchNetwork, WatchWallet } from '../watch.types';
import { DerivationService } from './derivation.service';

/**
 * Safety valve. A wallet with more than this many transactions is not something we can
 * page through in a browser tab without abusing the API. If we hit it we say so, loudly,
 * rather than silently showing a balance computed from a partial history.
 */
const MAX_PAGES = 200;
const PAGE_SIZE = 50;

function walletId(network: WatchNetwork, descriptor: string, scriptType: string): string {
  if (!['wsh', 'shwsh'].includes(scriptType.toLowerCase())) {
    return `${network}-${descriptor.slice(0, 24)}`;
  }
  let hash = 2166136261;
  for (let i = 0; i < descriptor.length; i++) {
    hash = Math.imul(hash ^ descriptor.charCodeAt(i), 16777619);
  }
  return `${network}-multisig-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export interface ScanProgress {
  phase: 'deriving' | 'fetching' | 'done';
  addressesDerived: number;
  txsFound: number;
  /** Set when the history was too large to page through completely. */
  truncated?: boolean;
}

/**
 * Gap-limit scan.
 *
 * Neither of the batch endpoints reports *which* addresses have history — but they don't
 * need to. The transactions themselves tell us: any address of ours appearing in a vin or
 * vout is used. So one paginated sweep over the address window gives us both the history
 * and the used-address set, with no per-address calls at all.
 *
 * Verified against production (see docs/watch-only-wallet-plan.md):
 *  - address count is not a constraint (124 in one POST is fine) — no chunking needed
 *  - POST /api/addresses/txs returns 50/page with an honest after_txid cursor
 *  - the response is deduplicated by txid, so a tx paying two of our addresses appears once
 *  - we deliberately do NOT use /txs/summary: it silently flat-tops at 5000 items
 */
@Injectable()
export class WalletScannerService {
  constructor(
    private electrsApiService: ElectrsApiService,
    private derivationService: DerivationService,
  ) {}

  /**
   * Derive and scan until both chains have `gapLimit` consecutive unused addresses.
   * Returns the wallet (with its full derived address set) and every transaction touching it.
   */
  async scan(
    descriptor: string,
    scriptType: string,
    network: WatchNetwork,
    gapLimit: number,
    source: string,
    label: string,
    identity: { fingerprint?: string; fingerprintIsMaster: boolean; originPath?: string },
    onProgress?: (p: ScanProgress) => void,
  ): Promise<{ wallet: WatchWallet; txs: Transaction[]; truncated: boolean }> {
    const derivedCount: Record<Chain, number> = { 0: 0, 1: 0 };
    const addresses: DerivedAddress[] = [];
    const byAddress = new Map<string, DerivedAddress>();
    const txsById = new Map<string, Transaction>();
    let truncated = false;

    // Extend a chain by `gapLimit` more addresses and return only the new ones,
    // so each round queries the API for addresses it has not asked about before.
    const extend = async (chain: Chain): Promise<DerivedAddress[]> => {
      onProgress?.({ phase: 'deriving', addressesDerived: addresses.length, txsFound: txsById.size });
      const from = derivedCount[chain];
      const fresh = await this.derivationService.derive(descriptor, network, chain, from, gapLimit);
      derivedCount[chain] = from + gapLimit;
      for (const a of fresh) {
        addresses.push(a);
        byAddress.set(a.address, a);
      }
      return fresh;
    };

    /** Highest used index on a chain, computed from the transactions we have so far. */
    const lastUsedOn = (chain: Chain): number => {
      let last = -1;
      const touch = (address?: string): void => {
        const d = address ? byAddress.get(address) : undefined;
        if (d && d.chain === chain && d.index > last) {
          last = d.index;
        }
      };
      for (const tx of txsById.values()) {
        for (const vin of tx.vin || []) {
          touch(vin.prevout?.scriptpubkey_address);
        }
        for (const vout of tx.vout || []) {
          touch(vout.scriptpubkey_address);
        }
      }
      return last;
    };

    let pagesUsed = 0;

    const fetchFor = async (targets: DerivedAddress[]): Promise<void> => {
      if (!targets.length) {
        return;
      }
      const addrs = targets.map((a) => a.address);
      let afterTxid: string | undefined;

      for (;;) {
        if (pagesUsed >= MAX_PAGES) {
          truncated = true;
          return;
        }
        onProgress?.({ phase: 'fetching', addressesDerived: addresses.length, txsFound: txsById.size });

        const page = await firstValueFrom(
          this.electrsApiService.getAddressesTransactions$(addrs, afterTxid),
        );
        pagesUsed++;

        if (!page || page.length === 0) {
          return;
        }
        for (const tx of page) {
          txsById.set(tx.txid, tx);
        }

        const next = page[page.length - 1].txid;
        // Guard against a cursor that stops advancing — better to stop than to spin.
        if (page.length < PAGE_SIZE || next === afterTxid) {
          return;
        }
        afterTxid = next;
      }
    };

    // Seed both chains, then keep extending whichever chain has activity near its edge.
    await fetchFor(await extend(0));
    await fetchFor(await extend(1));

    for (;;) {
      let extended = false;
      for (const chain of [0, 1] as Chain[]) {
        // Extend while the last used index is within `gapLimit` of the derived edge —
        // i.e. we have NOT yet seen gapLimit consecutive unused addresses.
        while (lastUsedOn(chain) >= derivedCount[chain] - gapLimit) {
          await fetchFor(await extend(chain));
          extended = true;
          if (truncated) {
            break;
          }
        }
      }
      if (!extended || truncated) {
        break;
      }
    }

    const txs = [...txsById.values()].sort((a, b) => {
      const ah = a.status?.confirmed ? a.status.block_height : Infinity;
      const bh = b.status?.confirmed ? b.status.block_height : Infinity;
      return bh - ah;
    });

    onProgress?.({ phase: 'done', addressesDerived: addresses.length, txsFound: txs.length, truncated });

    const wallet: WatchWallet = {
      id: walletId(network, descriptor, scriptType),
      label,
      source,
      descriptor,
      scriptType,
      fingerprint: identity.fingerprint,
      fingerprintIsMaster: identity.fingerprintIsMaster,
      originPath: identity.originPath,
      network,
      gapLimit,
      derivedCount,
      addresses,
    };

    return { wallet, txs, truncated };
  }
}
