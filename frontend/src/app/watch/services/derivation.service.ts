import { Injectable, Inject, PLATFORM_ID, OnDestroy } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { ScriptType, WatchNetwork, Chain, DerivedAddress } from '../watch.types';
import {
  PsbtBuildRequest,
  PsbtBuildResult,
  PsbtFinalizedResult,
  PsbtEstimateRequest,
  PsbtEstimateResult,
  PsbtMaxAmountRequest,
  PsbtMaxAmountResult,
} from '../psbt.utils';

/**
 * Main-thread facade over the derivation worker.
 *
 * The worker (and therefore the WASM) is created lazily on first use, so importing this
 * service costs nothing. It is never created during server-side rendering.
 */
@Injectable()
export class DerivationService implements OnDestroy {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(@Inject(PLATFORM_ID) private platformId: object) {}

  private getWorker(): Worker {
    if (!isPlatformBrowser(this.platformId)) {
      throw new Error('Address derivation is only available in the browser.');
    }
    if (!this.worker) {
      this.worker = new Worker(new URL('../derivation.worker', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        const entry = this.pending.get(data.id);
        if (!entry) {
          return;
        }
        this.pending.delete(data.id);
        data.ok ? entry.resolve(data.result) : entry.reject(new Error(data.error));
      };
      this.worker.onerror = (e) => {
        const err = new Error(`Derivation worker failed: ${e.message || 'unknown error'}`);
        this.pending.forEach((p) => p.reject(err));
        this.pending.clear();
      };
    }
    return this.worker;
  }

  private send<T>(msg: Record<string, unknown>): Promise<T> {
    const worker = this.getWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ ...msg, id });
    });
  }

  /**
   * Validate and normalize a pasted xpub/descriptor into a multipath descriptor.
   * Throws with a user-facing message if the input is not usable.
   */
  prepare(input: string, network: WatchNetwork, scriptTypeHint?: ScriptType): Promise<{
    descriptor: string;
    scriptType: string;
    descType: string;
    fingerprint?: string;
    fingerprintIsMaster: boolean;
    originPath?: string;
    signingOriginsComplete: boolean;
  }> {
    return this.send({ cmd: 'prepare', input, network, scriptTypeHint });
  }

  /** Derive `count` addresses on one chain, starting at `from`. */
  async derive(descriptor: string, network: WatchNetwork, chain: Chain, from: number, count: number): Promise<DerivedAddress[]> {
    const res = await this.send<{ addresses: { address: string; scriptPubKey: string }[] }>({
      cmd: 'derive', descriptor, network, chain, from, count,
    });
    return res.addresses.map(({ address, scriptPubKey }, i) => ({
      address, scriptPubKey, chain, index: from + i,
    }));
  }

  /** Construct a signing-ready PSBT using public descriptor data only. */
  buildPsbt(request: PsbtBuildRequest): Promise<PsbtBuildResult> {
    return this.send({ cmd: 'psbt-build', request });
  }

  /** Calculate the fee-adjusted output amount for a sweep without creating a PSBT. */
  maxSendAmount(request: PsbtMaxAmountRequest): Promise<PsbtMaxAmountResult> {
    return this.send({ cmd: 'psbt-max-amount', request });
  }

  /** Estimate the current send without constructing a PSBT or consuming a change index. */
  estimateTransaction(request: PsbtEstimateRequest): Promise<PsbtEstimateResult> {
    return this.send({ cmd: 'psbt-estimate', request });
  }

  /** Finalize signatures produced by an external signer and extract the raw transaction. */
  finalizePsbt(base64: string): Promise<PsbtFinalizedResult> {
    return this.send({ cmd: 'psbt-finalize', base64 });
  }

  ngOnDestroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
