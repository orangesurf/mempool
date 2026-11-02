import { HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { ElectrsApiService } from '@app/services/electrs-api.service';
import { Transaction } from '@interfaces/electrs.interface';
import { firstValueFrom } from 'rxjs';
import { RequestCancelledError, RetryOptions, RetryWait, withRetry } from '@app/watch/api-retry';
import { sortNewestFirst } from '@app/watch/wallet-math';
import {
  AddressListWallet,
  AddressListWalletDefinition,
  Chain,
  ChainTip,
  DerivedAddress,
  DescriptorWallet,
  DescriptorWalletDefinition,
  WalletDefinition,
  WatchWallet,
} from '@app/watch/watch.types';
import { DerivationService } from '@app/watch/services/derivation.service';
import { AddressRequestQueue } from '@app/watch/request-queue';

/**
 * Safety valve. A wallet with more than this many transactions is not something we can
 * page through in a browser tab without abusing the API. If we hit it we say so, loudly,
 * rather than silently showing a balance computed from a partial history.
 */
const MAX_PAGES = 200;
const PAGE_SIZE = 50;

/**
 * Most addresses sent in one POST /api/addresses/txs. A gap limit of up to 1,000 or a
 * 1,000-address list would otherwise go out as a single request, and the server reads the
 * history of every address in the body for each page it returns, so a very large body is
 * slow to answer and more likely to time out. Batches of 124 are known to work; 100 stays
 * within that and keeps a default scan (20 per chain) at one request per round.
 */
const MAX_ADDRESSES_PER_REQUEST = 100;

/**
 * How many of the newest synced blocks a per-block refresh reads again. The synced tip is
 * the server's own tip, read before the scan, but electrs reports a block as its tip before
 * it has indexed that block's history, and drops the block's transactions from its mempool
 * only after (electrs schema.rs `update`, then the main loop's mempool update). A scan in
 * that window can hold some of the block's transactions as unconfirmed and miss others, and
 * when blocks arrive faster than electrs indexes them the window spans several blocks.
 * Reading the last RECHECK_BLOCKS synced blocks again repairs that; it costs no extra request
 * unless the wallet has more than a page of transactions in them.
 *
 * When electrs lags further behind its tip than that, a per-block refresh can miss a
 * transaction for good: it stops at older history it already holds. So a per-block refresh
 * also becomes a full scan once the server's tip is RECHECK_BLOCKS past the tip of the last
 * full scan, which bounds how long such a gap can last to about an hour of blocks.
 */
const RECHECK_BLOCKS = 6;

/**
 * How many times one chunk's paging may start again from the top after the server's answer
 * shows that the cursor moved between the mempool and a block (see continuesFrom). Each
 * restart needs a block or a reorg to land between two requests, so this is only reached
 * when the history keeps changing under the scan.
 */
const MAX_RESTARTS = 3;

/** Stable id: the same descriptor, or the same list in the same order, maps to the same wallet. */
export async function walletId(definition: WalletDefinition): Promise<string> {
  const { network } = definition;
  const what = definition.kind === 'address-list'
    ? `addresses:${definition.addresses.map((a) => a.address).join(',')}`
    : definition.descriptor;
  const bytes = new TextEncoder().encode(`${network}\n${what}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${network}-${hex}`;
}

export interface ScanProgress {
  phase: 'deriving' | 'fetching' | 'done';
  addressesDerived: number;
  txsFound: number;
  /** API requests sent so far: the server's tip, and each page of POST /api/addresses/txs. */
  apiRequests: number;
  chain?: Chain;
  /** Set while a request is waiting to be retried after a 429, 503 or dropped connection. */
  retry?: RetryWait;
}

export interface WalletScanRequest {
  definition: WalletDefinition;
  /** Keep the id of a wallet that is being rescanned. */
  existingWalletId?: string;
  /** Derive at least this many addresses per chain, e.g. what an earlier scan reached. Descriptor wallets only. */
  minimumDerived?: Record<Chain, number>;
  onProgress?: (p: ScanProgress) => void;
  /** Stop the scan at its next request or retry wait, e.g. once the page has gone. */
  isCancelled?: () => boolean;
  /**
   * Build on an earlier scan of `definition`, which must then be the scanned wallet, instead
   * of reading every address's history again:
   *  - 'since': the per-block refresh. `transactions` were complete up to `tip`, the synced
   *    tip of the scan that produced them; read only what is newer, then extend the gap limit
   *    as a full scan would. `fullScanHeight` is the height of the synced tip of the last full
   *    scan these transactions build on (null when unknown); a full scan runs instead once
   *    the server's tip is RECHECK_BLOCKS past it.
   *  - 'extend': `transactions` are current, and complete up to `tip` (null when unknown);
   *    derive and fetch only the addresses the gap limit now needs beyond the derived edge.
   * Anything unexpected on the way falls back to a full scan; the result says which ran.
   */
  incremental?: IncrementalScan;
}

export type IncrementalScan =
  | { kind: 'since'; tip: ChainTip; transactions: Transaction[]; fullScanHeight: number | null }
  | { kind: 'extend'; tip: ChainTip | null; transactions: Transaction[] };

export interface WalletScanResult {
  wallet: WatchWallet;
  txs: Transaction[];
  truncated: boolean;
  /** True if the scan built on `incremental`; false if it read every address afresh. */
  incremental: boolean;
  /**
   * The server's tip, read before the scan's first history request: `txs` hold everything
   * confirmed up to it, apart from what RECHECK_BLOCKS allows for. Null when unknown (the
   * tip could not be read, or the scan was truncated); the next refresh is then a full scan.
   */
  syncedTip: ChainTip | null;
}

/**
 * A scan that could not read the whole history and has nothing complete to show for it. The
 * caller keeps what it showed before.
 *  - 'history-moved': the server's answers kept changing under the scan's cursor.
 *  - 'too-many-transactions': a refresh had to fall back to a full scan, and that scan hit
 *    MAX_PAGES. Its partial result would replace a complete one.
 */
export class ScanIncompleteError extends Error {
  constructor(readonly reason: 'history-moved' | 'too-many-transactions') {
    super(`Scan incomplete: ${reason}`);
  }
}

/** An incremental scan found something it cannot reconcile; a full scan follows. */
class IncrementalScanAborted extends Error {}

/** The server's newest blocks, newest first, as read before a scan. */
interface IndexTip {
  tip: ChainTip;
  recent: ChainTip[];
}

/**
 * True if the chain `index` was read from contains `synced` at its height, so it grew from
 * `synced` (or stayed there). False after a reorg below `synced`, when the server is behind
 * it, or when `synced` is older than the blocks the server returned.
 */
function indexExtends(index: IndexTip, synced: ChainTip): boolean {
  const block = index.recent.find((b) => b.height === synced.height);
  return !!block && block.hash === synced.hash;
}

/**
 * True if `page`, the answer to a request with the cursor at the end of `previous`, carries on
 * from where `previous` left off.
 *
 * electrs looks the cursor up afresh on every request (rest.rs find_txid): in its mempool
 * first, then in the chain. If the cursor's transaction was unconfirmed in `previous` but has
 * since been mined, the server resolves it in its block and continues from there, skipping the
 * rest of the mempool and any confirmed history above that block; it answers 200, not 422. The
 * reverse happens when a reorg returns the cursor to the mempool. Such a page starts with the
 * wrong kind of transaction:
 *  - after an unconfirmed cursor, the next page starts with the rest of the mempool. A
 *    confirmed first transaction, or an empty page after a full one, means the cursor may
 *    have moved, or the mempool part may have ended exactly at the cursor; fetchChunk asks
 *    again to tell which.
 *  - after a confirmed cursor, the next page holds only confirmed transactions.
 */
function continuesFrom(previous: Transaction[], page: Transaction[]): boolean {
  const cursorConfirmed = !!previous[previous.length - 1].status?.confirmed;
  if (page.length === 0) {
    // A short page whose last transaction is unconfirmed had room for confirmed history and
    // found none, so an empty page next is the end. After a full page it may not be.
    return cursorConfirmed || previous.length < PAGE_SIZE;
  }
  return !!page[0].status?.confirmed === cursorConfirmed;
}

/**
 * The transactions of a set of addresses, gathered over paginated batch requests and
 * deduplicated by txid. One collector serves a whole scan, so MAX_PAGES bounds the scan; a
 * full scan that follows an aborted incremental one gets a collector, and a budget, of its own.
 *
 * A large address set is sent in chunks. Each chunk is paged on its own: the after_txid
 * cursor walks the history of the addresses in that request, so it cannot carry over to
 * another chunk. A chunk's transactions are stored only once its paging has finished (see
 * fetchChunk). A transaction touching addresses in two chunks comes back in both and is
 * stored once.
 */
class HistoryCollector {
  readonly txsById: Map<string, Transaction>;
  /** Pages this collector requested, counted against MAX_PAGES. */
  pages = 0;
  truncated = false;
  /** The transactions of the chunk being read, which are stored only once it has been read. */
  private reading = new Map<string, Transaction>();

  constructor(
    private electrsApiService: ElectrsApiService,
    private retryOptions: RetryOptions,
    known: Transaction[] = [],
    /** Requests the scan sent before this collector's first, for progress reports. */
    private requestsBefore = 0,
  ) {
    this.txsById = new Map(known.map((tx) => [tx.txid, tx]));
  }

  /** Every request of the scan so far, this collector's included. */
  get requests(): number {
    return this.requestsBefore + this.pages;
  }

  /**
   * Transactions found so far, for progress reports: those in `into` and those of the chunk
   * being read that it does not hold yet. A chunk that starts again drops its count.
   */
  found(into: Map<string, Transaction> = this.txsById): number {
    let pending = 0;
    for (const txid of this.reading.keys()) {
      if (!into.has(txid)) {
        pending++;
      }
    }
    return into.size + pending;
  }

  /** Fetch every page of history for `addresses`. `beforeRequest` runs before each request. */
  async fetch(addresses: string[], beforeRequest: () => void): Promise<void> {
    for (let start = 0; start < addresses.length && !this.truncated; start += MAX_ADDRESSES_PER_REQUEST) {
      const chunk = await this.fetchChunk(addresses.slice(start, start + MAX_ADDRESSES_PER_REQUEST), beforeRequest, () => true);
      for (const tx of chunk) {
        this.txsById.set(tx.txid, tx);
      }
    }
  }

  /**
   * Fetch only the newest part of the history of `addresses`, into `into` rather than the
   * collected set. The server returns each request's unconfirmed transactions first, then its
   * confirmed ones from the newest block down, so each chunk is read until its first
   * transaction confirmed at or below `floor` that `settled` holds: everything after it is
   * older still, and already known. That stop also saves the empty request that ends a chunk.
   */
  async fetchSince(
    addresses: string[],
    floor: number,
    settled: Set<string>,
    into: Map<string, Transaction>,
    beforeRequest: () => void,
  ): Promise<void> {
    for (let start = 0; start < addresses.length && !this.truncated; start += MAX_ADDRESSES_PER_REQUEST) {
      const chunk = await this.fetchChunk(addresses.slice(start, start + MAX_ADDRESSES_PER_REQUEST), beforeRequest,
        (tx) => !(tx.status?.confirmed && tx.status.block_height <= floor && settled.has(tx.txid)));
      for (const tx of chunk) {
        into.set(tx.txid, tx);
      }
    }
  }

  /**
   * Page through one chunk and return its transactions, up to the first one `wanted` rejects.
   *
   * Only an empty page ends the chunk. electrs takes up to 50 candidates and then drops any
   * whose previous outputs it cannot look up (rest.rs prepare_txs), so a shorter page does not
   * mean the history ended. A page that comes back empty because every candidate was dropped
   * cannot be told from the end and is taken as the end: the next full scan reads it again.
   *
   * A page that may not carry on from an unconfirmed cursor (continuesFrom) is checked with
   * one more request, from the transaction before the cursor: if the cursor is still in the
   * mempool it comes back first, unconfirmed, and that answer carries on correctly. Otherwise,
   * or after a confirmed cursor, the chunk starts again from the top, and what it returned
   * before is dropped: a transaction on one of the abandoned pages may have left the mempool
   * since, and must not be kept because an earlier page held it. If the same answer comes back
   * at the same cursor after starting again, it is taken as it is. Throws
   * ScanIncompleteError('history-moved') rather than start again more than MAX_RESTARTS times.
   *
   * The caller stores the result only once the chunk has been read, so a chunk that throws
   * leaves nothing behind. A chunk cut short by MAX_PAGES returns what it read.
   */
  private async fetchChunk(addresses: string[], beforeRequest: () => void, wanted: (tx: Transaction) => boolean): Promise<Transaction[]> {
    /** This traversal's transactions, by txid. */
    const found = new Map<string, Transaction>();
    this.reading = found;
    let afterTxid: string | undefined;
    /** The page that ended at afterTxid. */
    let previous: Transaction[] = [];
    /** Set while asking again from the transaction before `cursor`, after `answer` came back. */
    let checking: { cursor: string; answer: string } | null = null;
    /** "cursor first-txid" of each answer that started the chunk again. */
    const restartedOn = new Set<string>();
    const restart = (answer: string): void => {
      if (restartedOn.size >= MAX_RESTARTS) {
        throw new ScanIncompleteError('history-moved');
      }
      restartedOn.add(answer);
      found.clear();
      afterTxid = undefined;
      previous = [];
    };

    for (;;) {
      if (this.pages >= MAX_PAGES) {
        this.truncated = true;
        return [...found.values()];
      }
      beforeRequest();

      // Requests stay sequential: one page at a time, retried in place when the server asks us to slow down.
      const cursor = afterTxid;
      const page = await withRetry(
        () => firstValueFrom(this.electrsApiService.getAddressesTransactions$(addresses, cursor)),
        this.retryOptions,
      ) || [];
      this.pages++;

      if (checking) {
        const { cursor: moved, answer } = checking;
        checking = null;
        if (page[0]?.txid !== moved || page[0].status?.confirmed) {
          restart(answer);
          continue;
        }
      } else if (cursor && !continuesFrom(previous, page)) {
        const answer = `${cursor} ${page[0]?.txid ?? ''}`;
        if (!restartedOn.has(answer)) {
          if (!previous[previous.length - 1].status?.confirmed && previous.length > 1) {
            checking = { cursor, answer };
            afterTxid = previous[previous.length - 2].txid;
          } else {
            restart(answer);
          }
          continue;
        }
      }

      if (page.length === 0) {
        return [...found.values()];
      }
      for (const tx of page) {
        if (!wanted(tx)) {
          return [...found.values()];
        }
        found.set(tx.txid, tx);
      }

      const next = page[page.length - 1].txid;
      // Guard against a cursor that stops advancing — better to stop than to spin.
      if (next === afterTxid) {
        return [...found.values()];
      }
      afterTxid = next;
      previous = page;
    }
  }
}

/**
 * Merge a per-block refresh into the history it started from. Above `floor` the server's
 * answer replaces ours: a confirmed transaction we held there that did not come back was in a
 * block that has been replaced, and goes. Unconfirmed ones always come back (see scanFrom). At
 * or below `floor` our history stands.
 */
function mergeSince(held: Transaction[], recent: Map<string, Transaction>, floor: number): Transaction[] {
  const merged = new Map(held
    .filter((tx) => !(tx.status?.confirmed && tx.status.block_height > floor && !recent.has(tx.txid)))
    .map((tx) => [tx.txid, tx]));
  for (const tx of recent.values()) {
    merged.set(tx.txid, tx);
  }
  return [...merged.values()];
}

const isUnexpectedAnswer = (e: unknown): boolean => e instanceof HttpErrorResponse && e.status === 422;

/**
 * Wallet scans.
 *
 * Neither of the batch endpoints reports *which* addresses have history — but they don't
 * need to. The transactions themselves tell us: any address of ours appearing in a vin or
 * vout is used. So one paginated sweep over the address window gives us both the history
 * and the used-address set, with no per-address calls at all.
 *
 * A descriptor wallet is scanned to its gap limit; an address list is scanned as given.
 *
 * Batch behavior verified against the Mempool API:
 *  - 124 addresses in one POST is fine; larger sets are chunked (MAX_ADDRESSES_PER_REQUEST)
 *  - POST /api/addresses/txs returns up to 50/page with an honest after_txid cursor; a page
 *    can be shorter while more history follows (see fetchChunk)
 *  - the response is deduplicated by txid, so a tx paying two of our addresses appears once
 *  - unconfirmed transactions come first, grouped by address rather than by time, then
 *    confirmed ones from the newest block down; the per-block refresh relies on that order
 *  - we deliberately do NOT use /txs/summary: it silently flat-tops at 5000 items
 *
 * Each scan first reads the server's tip (GET /api/blocks/), so the history it returns is
 * known to be complete up to a block of the index that answered, not of the page's own
 * block feed, which can run ahead of it.
 *
 * Requests are sent one at a time. 429 and 503 are retried with backoff (see api-retry.ts);
 * a scan that still fails throws, and the caller keeps what it showed before.
 */
@Injectable()
export class WalletScannerService {
  constructor(
    private electrsApiService: ElectrsApiService,
    private derivationService: DerivationService,
    private addressRequestQueue: AddressRequestQueue,
  ) {}

  private queued(options: RetryOptions): RetryOptions {
    return { ...options, queue: this.addressRequestQueue.queue };
  }

  /**
   * Which of `addresses` have history, from ONE request for the first page of their combined
   * history (retried like the scan's requests). Used to tell a bare xpub's script type from
   * receive address 0 of each type. A first page full of one address's transactions can hide
   * another's; that is accepted to keep this to a single request.
   */
  async addressesWithHistory(addresses: string[], options: RetryOptions = {}): Promise<Set<string>> {
    const page = await withRetry(() => firstValueFrom(this.electrsApiService.getAddressesTransactions$(addresses)), this.queued(options));
    const wanted = new Set(addresses);
    const used = new Set<string>();
    const touch = (address?: string): void => {
      if (address && wanted.has(address)) {
        used.add(address);
      }
    };
    for (const tx of page || []) {
      for (const vin of tx.vin || []) {
        touch(vin.prevout?.scriptpubkey_address);
      }
      for (const vout of tx.vout || []) {
        touch(vout.scriptpubkey_address);
      }
    }
    return used;
  }

  /**
   * Scan a wallet. Returns it (with its full address set) and every transaction touching it.
   * With `request.incremental`, builds on an earlier scan and falls back to a full one when
   * that cannot be done safely.
   */
  async scan(request: WalletScanRequest): Promise<WalletScanResult> {
    const { definition, existingWalletId, isCancelled, incremental } = request;
    // Remember the last progress report, so a retry notice can be shown on top of it.
    let last: ScanProgress = { phase: 'deriving', addressesDerived: 0, txsFound: 0, apiRequests: 0 };
    const onProgress = (p: ScanProgress): void => {
      last = p;
      request.onProgress?.(p);
    };
    const retryOptions: RetryOptions = {
      isCancelled,
      onWait: (wait) => request.onProgress?.({ ...last, retry: wait ?? undefined }),
    };
    const addressRequestOptions = this.queued(retryOptions);
    const id = existingWalletId ?? await walletId(definition);
    const scanned = 'addresses' in definition && 'derivedCount' in definition ? definition as WatchWallet : null;

    let requests = 0;
    let index: IndexTip | null | undefined;
    const readIndexTip = async (): Promise<IndexTip | null> => {
      requests++;
      return this.indexTip(retryOptions);
    };

    if (incremental && scanned) {
      try {
        let syncedTip = incremental.tip;
        if (incremental.kind === 'since') {
          index = await readIndexTip();
          if (!index || !indexExtends(index, incremental.tip) || this.dueForFullScan(index.tip, incremental.fullScanHeight)) {
            throw new IncrementalScanAborted();
          }
          syncedTip = index.tip;
        }
        const history = new HistoryCollector(this.electrsApiService, addressRequestOptions, incremental.transactions, requests);
        try {
          const wallet = await this.scanFrom(scanned, id, incremental, history, { ...request, onProgress });
          return this.finish(wallet, history, true, syncedTip, onProgress);
        } finally {
          requests = history.requests;
        }
      } catch (e) {
        if (!(e instanceof IncrementalScanAborted) && !(e instanceof ScanIncompleteError) && !isUnexpectedAnswer(e)) {
          throw e;
        }
      }
    }

    // A full scan, with a page budget of its own. The tip read for an aborted 'since' scan is
    // older than any of the requests below, so it still bounds what they find.
    if (index === undefined) {
      index = await readIndexTip();
    }
    const history = new HistoryCollector(this.electrsApiService, addressRequestOptions, [], requests);
    const wallet = definition.kind === 'address-list'
      ? await this.scanAddressList(definition, id, history, onProgress)
      : await this.scanDescriptor(definition, id, history, { ...request, onProgress });
    if (history.truncated && incremental && scanned) {
      // The refresh started from a complete history; a truncated one must not replace it.
      throw new ScanIncompleteError('too-many-transactions');
    }
    return this.finish(wallet, history, false, index?.tip ?? null, onProgress);
  }

  /**
   * True when a per-block refresh should read every address's history again: the last full
   * scan's synced tip is unknown, or `tip` is RECHECK_BLOCKS or more past it (see RECHECK_BLOCKS).
   */
  private dueForFullScan(tip: ChainTip, fullScanHeight: number | null): boolean {
    return typeof fullScanHeight !== 'number' || tip.height - fullScanHeight >= RECHECK_BLOCKS;
  }

  /**
   * The server's tip and the blocks below it, from one GET /api/blocks/ (its newest blocks,
   * ten by default, so height and hash come from the same moment). Null when it cannot be
   * read: the scan then goes ahead with an unknown synced tip.
   */
  private async indexTip(retryOptions: RetryOptions): Promise<IndexTip | null> {
    let blocks: { id: string; height: number }[] | null;
    try {
      blocks = await withRetry(() => firstValueFrom(this.electrsApiService.listBlocks$()), retryOptions);
    } catch (e) {
      if (e instanceof RequestCancelledError) {
        throw e;
      }
      return null;
    }
    const recent = (Array.isArray(blocks) ? blocks : [])
      .filter((b) => typeof b?.id === 'string' && Number.isInteger(b?.height))
      .map((b) => ({ height: b.height, hash: b.id }))
      .sort((a, b) => b.height - a.height);
    return recent.length ? { tip: recent[0], recent } : null;
  }

  private finish(
    wallet: WatchWallet,
    history: HistoryCollector,
    incremental: boolean,
    syncedTip: ChainTip | null,
    onProgress: (p: ScanProgress) => void,
  ): WalletScanResult {
    const txs = sortNewestFirst([...history.txsById.values()]);
    onProgress({ phase: 'done', addressesDerived: wallet.addresses.length, txsFound: txs.length, apiRequests: history.requests });
    return { wallet, txs, truncated: history.truncated, incremental, syncedTip: history.truncated ? null : syncedTip };
  }

  /**
   * The incremental scans. 'since' reads what is newer than the synced block for every
   * address, then both kinds extend a descriptor wallet's window as a full scan would,
   * fetching the whole history of each newly derived address. Throws IncrementalScanAborted
   * when the result could differ from a full scan's.
   */
  private async scanFrom(
    wallet: WatchWallet,
    id: string,
    incremental: IncrementalScan,
    history: HistoryCollector,
    request: WalletScanRequest,
  ): Promise<WatchWallet> {
    if (incremental.kind === 'since') {
      const floor = incremental.tip.height - RECHECK_BLOCKS;
      const settled = new Set(incremental.transactions
        .filter((tx) => tx.status?.confirmed && tx.status.block_height <= floor)
        .map((tx) => tx.txid));
      const recent = new Map<string, Transaction>();
      await history.fetchSince(wallet.addresses.map((a) => a.address), floor, settled, recent, () => request.onProgress?.({
        phase: 'fetching',
        addressesDerived: wallet.addresses.length,
        txsFound: history.found(recent),
        apiRequests: history.requests + 1,
      }));
      if (history.truncated) {
        throw new IncrementalScanAborted();
      }
      // The mempool part of every answer is read in full, and a transaction that has been mined
      // since is in a block above the floor, so one we held as unconfirmed comes back unless it
      // has left the mempool unmined (replaced, evicted) or electrs's index was further behind
      // its tip than RECHECK_BLOCKS when we read it. A full scan tells those apart.
      if (incremental.transactions.some((tx) => !tx.status?.confirmed && !recent.has(tx.txid))) {
        throw new IncrementalScanAborted();
      }
      history.txsById.clear();
      for (const tx of mergeSince(incremental.transactions, recent, floor)) {
        history.txsById.set(tx.txid, tx);
      }
    }
    if (wallet.kind === 'address-list') {
      return { ...wallet, id };
    }
    const scanned = await this.scanDescriptor(wallet, id, history, request, wallet);
    if (history.truncated) {
      throw new IncrementalScanAborted();
    }
    return scanned;
  }
  /** An address list has nothing to derive: fetch the history of exactly the listed addresses. */
  private async scanAddressList(
    definition: AddressListWalletDefinition,
    id: string,
    history: HistoryCollector,
    onProgress?: (p: ScanProgress) => void,
  ): Promise<AddressListWallet> {
    const addresses = definition.addresses;
    await history.fetch(addresses.map((a) => a.address), () => onProgress?.({
      phase: 'fetching',
      addressesDerived: addresses.length,
      txsFound: history.found(),
      apiRequests: history.requests + 1,
    }));
    return { ...definition, id, derivedCount: { 0: addresses.length, 1: 0 } };
  }

  /**
   * Derive and scan until both chains have `gapLimit` consecutive unused addresses. `from`
   * is an earlier scan whose addresses `history` already covers: the window then grows from
   * its edge instead of being derived and fetched from index 0.
   */
  private async scanDescriptor(
    definition: DescriptorWalletDefinition,
    id: string,
    history: HistoryCollector,
    { onProgress, minimumDerived }: WalletScanRequest,
    from?: DescriptorWallet,
  ): Promise<DescriptorWallet> {
    const { descriptor, network, gapLimit } = definition;
    const derivedCount: Record<Chain, number> = from ? { ...from.derivedCount } : { 0: 0, 1: 0 };
    const addresses: DerivedAddress[] = from ? [...from.addresses] : [];
    const byAddress = new Map(addresses.map((a) => [a.address, a]));

    const report = (phase: ScanProgress['phase'], chain: Chain, apiRequests: number): void => onProgress?.({
      phase,
      addressesDerived: addresses.length,
      txsFound: history.found(),
      chain,
      apiRequests,
    });

    // Extend a chain by `count` more addresses and return only the new ones,
    // so each round queries the API for addresses it has not asked about before.
    const extend = async (chain: Chain, count: number): Promise<DerivedAddress[]> => {
      report('deriving', chain, history.requests);
      const from = derivedCount[chain];
      const fresh = await this.derivationService.derive(descriptor, network, chain, from, count);
      derivedCount[chain] = from + count;
      for (const a of fresh) {
        addresses.push(a);
        byAddress.set(a.address, a);
      }
      return fresh;
    };

    const fetchFor = (targets: DerivedAddress[]): Promise<void> => history.fetch(
      targets.map((a) => a.address),
      () => report('fetching', targets[0].chain, history.requests + 1),
    );

    /** Highest used index on a chain, computed from the transactions we have so far. */
    const lastUsedOn = (chain: Chain): number => {
      let last = -1;
      const touch = (address?: string): void => {
        const d = address ? byAddress.get(address) : undefined;
        if (d && d.chain === chain && d.index > last) {
          last = d.index;
        }
      };
      for (const tx of history.txsById.values()) {
        for (const vin of tx.vin || []) {
          touch(vin.prevout?.scriptpubkey_address);
        }
        for (const vout of tx.vout || []) {
          touch(vout.scriptpubkey_address);
        }
      }
      return last;
    };

    // Seed both chains, then keep extending whichever chain has activity near its edge.
    if (!from) {
      await fetchFor(await extend(0, gapLimit));
      await fetchFor(await extend(1, gapLimit));
    }

    // Never shrink below what an earlier scan derived: a receive address handed out with
    // "Use next address" may be paid later, and must still be watched.
    for (const chain of [0, 1] as Chain[]) {
      const missing = (minimumDerived?.[chain] ?? 0) - derivedCount[chain];
      if (missing > 0 && !history.truncated) {
        await fetchFor(await extend(chain, missing));
      }
    }

    for (;;) {
      let extended = false;
      for (const chain of [0, 1] as Chain[]) {
        // Extend until gapLimit consecutive unused addresses follow the last used one, deriving
        // only the shortfall: one used address at index 0 needs indices 1..gapLimit, not
        // another full block of gapLimit.
        while (lastUsedOn(chain) >= derivedCount[chain] - gapLimit) {
          await fetchFor(await extend(chain, lastUsedOn(chain) + gapLimit + 1 - derivedCount[chain]));
          extended = true;
          if (history.truncated) {
            break;
          }
        }
      }
      if (!extended || history.truncated) {
        break;
      }
    }

    return { ...definition, id, derivedCount, addresses };
  }
}
