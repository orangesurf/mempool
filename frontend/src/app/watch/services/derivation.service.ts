import { Injectable, Inject, PLATFORM_ID, OnDestroy } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { AddressListResult, DerivationRequest, DerivationResponse, DeriveResult, PrepareResult, ScriptCandidatesResult } from '@app/watch/derivation.messages';
import { describeInputError } from '@app/watch/input-errors';
import { Chain, DerivedAddress, ScriptType, WatchNetwork } from '@app/watch/watch.types';

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** An unexpected failure in the worker. `reason` is the error's own, untranslated, message. */
function derivationFailed(reason: string | undefined): string {
  return reason
    ? $localize`:@@watch.error.worker-failed:Address derivation failed: ${reason}:reason:`
    : $localize`:@@watch.error.worker-failed-unknown:Address derivation failed.`;
}

/**
 * Main-thread facade over the derivation worker.
 *
 * The worker is created on first use, so injecting this service costs nothing, and it is
 * never created during server-side rendering.
 */
@Injectable()
export class DerivationService implements OnDestroy {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(@Inject(PLATFORM_ID) private platformId: object) {}

  /**
   * Validate and normalize a pasted xpub/descriptor into a multipath descriptor.
   * Rejects with a user-facing message if the input is not usable.
   */
  prepare(input: string, network: WatchNetwork, scriptTypeHint?: ScriptType): Promise<PrepareResult> {
    return this.send<PrepareResult>({ cmd: 'prepare', input, network, scriptTypeHint });
  }

  /**
   * Receive address 0 of a bare xpub/tpub under each script type it could be. Resolves to an
   * empty list for any other input.
   */
  async scriptCandidates(input: string, network: WatchNetwork): Promise<ScriptCandidatesResult['candidates']> {
    const res = await this.send<ScriptCandidatesResult>({ cmd: 'script-candidates', input, network });
    return res.candidates;
  }

  /** Derive `count` addresses on one chain, starting at `from`. */
  async derive(descriptor: string, network: WatchNetwork, chain: Chain, from: number, count: number): Promise<DerivedAddress[]> {
    const res = await this.send<DeriveResult>({ cmd: 'derive', descriptor, network, chain, from, count });
    return res.addresses.map(({ address, scriptPubKey }, i) => ({ address, scriptPubKey, chain, index: from + i }));
  }

  /**
   * Validate a pasted address list for the network. Resolves to its distinct addresses as
   * receive-chain entries numbered in the order pasted; rejects with a message naming the
   * first unusable entry.
   */
  async parseAddressList(input: string, network: WatchNetwork): Promise<DerivedAddress[]> {
    const res = await this.send<AddressListResult>({ cmd: 'address-list', input, network });
    return res.addresses.map(({ address, scriptPubKey }, index) => ({ address, scriptPubKey, chain: 0, index }));
  }

  ngOnDestroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }

  private send<T>(msg: DistributiveOmit<DerivationRequest, 'id'>): Promise<T> {
    const worker = this.getWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ ...msg, id });
    });
  }

  private getWorker(): Worker {
    if (!isPlatformBrowser(this.platformId)) {
      throw new Error($localize`:@@watch.error.browser-only:Addresses can only be derived in the browser.`);
    }
    if (!this.worker) {
      this.worker = new Worker(new URL('../derivation.worker', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }: MessageEvent<DerivationResponse>): void => {
        const entry = this.pending.get(data.id);
        if (!entry) {
          return;
        }
        this.pending.delete(data.id);
        if (data.ok) {
          entry.resolve(data.result);
        } else {
          entry.reject(new Error(data.code ? describeInputError(data.code, data.params) : derivationFailed(data.error)));
        }
      };
      this.worker.onerror = (e): void => {
        const err = new Error(derivationFailed(e.message));
        this.pending.forEach((p) => p.reject(err));
        this.pending.clear();
      };
    }
    return this.worker;
  }
}
