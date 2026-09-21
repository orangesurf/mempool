/**
 * Watch-only wallet types.
 *
 * The extended key never leaves the browser: it is pasted by the user, normalized
 * and derived client-side, and only the resulting *addresses* are ever sent to the
 * server (as ordinary address queries, exactly as if the user had searched for them).
 */

/** Script type of a wallet, inferred from a SLIP-132 prefix or a descriptor. */
export type ScriptType = 'pkh' | 'sh_wpkh' | 'wpkh' | 'tr' | 'wsh' | 'sh_wsh';

/** Networks we support. Deliberately excludes Liquid (needs blinding keys, not just an xpub). */
export type WatchNetwork = 'mainnet' | 'testnet' | 'testnet4' | 'signet';

/** 0 = external/receive chain, 1 = internal/change chain (BIP-44 semantics). */
export type Chain = 0 | 1;

export interface DerivedAddress {
  address: string;
  chain: Chain;
  index: number;
  /** Hex-encoded locking script, derived with the address and safe to persist. */
  scriptPubKey?: string;
}

export type Bip329LabelType = 'tx' | 'addr' | 'output';


/** The BIP-329 fields this wallet imports and exports as JSON Lines. */
export interface Bip329Label {
  type: Bip329LabelType;
  ref: string;
  label: string;
}

/** A UTXO, derived client-side from the wallet's transaction history. */
export interface WalletUtxo {
  txid: string;
  vout: number;
  value: number;
  address: string;
  confirmed: boolean;
  blockHeight?: number;
}

/** A transaction that touches the wallet, with its net effect on the balance. */
export interface WalletTx {
  txid: string;
  /** Net effect in sats: positive = received, negative = sent. Fee is included in the negative case. */
  netValue: number;
  confirmed: boolean;
  blockHeight?: number;
  blockTime?: number;
}

export interface WalletBalance {
  /** Sum of confirmed UTXOs. */
  confirmed: number;
  /** Net effect of unconfirmed (mempool) transactions. May be negative. */
  pending: number;
  /** confirmed + pending. */
  total: number;
}

/**
 * A watch-only wallet.
 *
 * `source` holds the pasted xpub/descriptor in plaintext. This is a deliberate,
 * documented decision (see docs/watch-only-wallet-plan.md § "Accepted risk"): it is
 * what lets the gap limit auto-extend without re-prompting. All persistence goes
 * through WalletStorageService so the policy can be changed in one place.
 */
export interface WatchWallet {
  id: string;
  label: string;
  /** The raw string the user pasted (xpub/ypub/zpub/tpub/... or a BIP-380 descriptor). */
  source: string;
  /** Normalized BIP-380 multipath descriptor: index 0 = receive, 1 = change. */
  descriptor: string;
  scriptType: ScriptType | string;
  /**
   * 8 hex chars identifying the wallet.
   *
   * When `fingerprintIsMaster` is true this is the true BIP-32 master fingerprint — the one a
   * hardware wallet shows as its XFP, so the user can confirm they imported the right wallet.
   * It is only knowable from a descriptor's key origin (`[73c5da0a/84h/0h/0h]`) or from a
   * depth-0 key.
   *
   * When false, it is the fingerprint of the *account* key that was pasted. Still a stable
   * identifier for this wallet, but it will NOT match the device's XFP — so the UI must not
   * call it a master fingerprint.
   */
  fingerprint?: string;
  fingerprintIsMaster: boolean;
  /** The real derivation path, when a descriptor told us (e.g. "m/84'/0'/0'"). */
  originPath?: string;
  /** Every signing key has a master fingerprint and an origin matching its xpub depth. */
  signingOriginsComplete?: boolean;
  network: WatchNetwork;
  gapLimit: number;
  /** How many addresses have been derived on each chain. */
  derivedCount: Record<Chain, number>;
  addresses: DerivedAddress[];

}

/** Everything the UI needs about a scanned wallet. Recomputed from tx history. */
export interface WalletState {
  wallet: WatchWallet;
  balance: WalletBalance;
  utxos: WalletUtxo[];
  txs: WalletTx[];
  /** Highest used index per chain; -1 when the chain has never been used. */
  lastUsed: Record<Chain, number>;
  scanning: boolean;
  error?: string;
}
