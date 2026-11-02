/**
 * Messages exchanged with derivation.worker.ts. Kept in their own file so the main bundle
 * can share the types without compiling the worker against the DOM typings.
 */

import { Chain, ScriptType, WatchNetwork } from '@app/watch/watch.types';

export interface PrepareRequest {
  id: number;
  cmd: 'prepare';
  input: string;
  network: WatchNetwork;
  /** Override for a bare xpub, whose script type is genuinely ambiguous. */
  scriptTypeHint?: ScriptType;
}

export interface PrepareResult {
  descriptor: string;
  scriptType: string;
  fingerprint?: string;
  fingerprintIsMaster: boolean;
  originPath?: string;
}

export interface DeriveRequest {
  id: number;
  cmd: 'derive';
  descriptor: string;
  network: WatchNetwork;
  chain: Chain;
  from: number;
  count: number;
}

export interface DeriveResult {
  addresses: { address: string; scriptPubKey: string }[];
}

export interface AddressListRequest {
  id: number;
  cmd: 'address-list';
  input: string;
  network: WatchNetwork;
}

export interface AddressListResult {
  /** Distinct, checksum-valid addresses in canonical form, in the order pasted. */
  addresses: { address: string; scriptPubKey: string }[];
}

/** Receive address 0 of a bare xpub/tpub under each script type it could be, to look up which has history. */
export interface ScriptCandidatesRequest {
  id: number;
  cmd: 'script-candidates';
  input: string;
  network: WatchNetwork;
}

export interface ScriptCandidatesResult {
  /** Empty when the input is not a bare xpub/tpub, whose script type is already known or not needed. */
  candidates: { scriptType: ScriptType; address: string }[];
}

export type DerivationRequest = PrepareRequest | DeriveRequest | AddressListRequest | ScriptCandidatesRequest;

/**
 * Why pasted input was refused. The worker cannot use $localize, so it reports a code and
 * its parameters, and the main thread words the message (see input-errors.ts).
 */
export type InputErrorCode =
  | 'private-key'
  | 'unrecognized-input'
  | 'key-network'
  | 'descriptor-key-network'
  | 'descriptor-network'
  | 'xpub-prefix'
  | 'xpub-length'
  | 'xpub-checksum'
  | 'xpub-version'
  | 'descriptor-character'
  | 'descriptor-checksum'
  | 'address-other-network'
  | 'address-invalid'
  | 'address-list-empty'
  | 'address-list-too-long'
  | 'unsupported-script-type'
  // Raised by descriptor.ts.
  | 'descriptor-step-invalid'
  | 'descriptor-step-range'
  | 'descriptor-hardened-step'
  | 'descriptor-origin-unclosed'
  | 'descriptor-origin-fingerprint'
  | 'descriptor-fixed-key'
  | 'descriptor-key-type'
  | 'descriptor-key-invalid'
  | 'descriptor-key-unranged'
  | 'descriptor-wildcard'
  | 'descriptor-multipath-count'
  | 'descriptor-multipath-invalid'
  | 'descriptor-multipath-short'
  | 'descriptor-multipath-duplicate'
  | 'descriptor-wsh-inner'
  | 'descriptor-threshold-number'
  | 'descriptor-multisig-keys'
  | 'descriptor-threshold-range'
  | 'descriptor-whitespace'
  | 'descriptor-checksum-present'
  | 'descriptor-unrecognized'
  | 'descriptor-taproot-script'
  | 'descriptor-sh-inner'
  | 'descriptor-function'
  | 'descriptor-no-multipath'
  | 'descriptor-multipath-lengths'
  | 'descriptor-chain'
  | 'descriptor-index'
  | 'derivation-no-public-key'
  | 'derivation-no-address';

export type InputErrorParams = Record<string, string | number>;

export class InputError extends Error {
  constructor(readonly code: InputErrorCode, readonly params: InputErrorParams = {}) {
    super(code);
  }
}

export interface DerivationResponse {
  id: number;
  ok: boolean;
  result?: PrepareResult | DeriveResult | AddressListResult | ScriptCandidatesResult;
  /** Set with `code` for refused input; otherwise an unexpected error's own message. */
  error?: string;
  code?: InputErrorCode;
  params?: InputErrorParams;
}
