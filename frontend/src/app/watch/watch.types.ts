/**
 * Watch-only wallet types.
 *
 * The extended key never leaves the browser: it is pasted by the user, normalized and
 * derived client-side, and only the resulting addresses are sent to the server, as
 * ordinary address queries.
 */

/** Script type of a wallet, inferred from a SLIP-132 prefix or a descriptor. */
export type ScriptType = 'pkh' | 'sh_wpkh' | 'wpkh' | 'tr' | 'wsh' | 'sh_wsh';

/** The networks the wallet runs on; WalletAccessService has the reasons for the others. */
export type WatchNetwork = 'mainnet' | 'testnet' | 'signet';

/** 0 = external/receive chain, 1 = internal/change chain (BIP-44 semantics). */
export type Chain = 0 | 1;

export interface DerivedAddress {
  address: string;
  chain: Chain;
  index: number;
  /** Hex-encoded locking script, derived with the address. */
  scriptPubKey?: string;
}

/** An unspent output, derived from the wallet's transaction history. */
export interface WalletUtxo {
  txid: string;
  vout: number;
  value: number;
  address: string;
  confirmed: boolean;
  blockHeight?: number;
}

export interface WalletBalance {
  /** Sum of confirmed UTXOs. */
  confirmed: number;
  /** Net effect of unconfirmed (mempool) transactions. May be negative. */
  pending: number;
  /** confirmed + pending. */
  total: number;
}

interface WalletDefinitionBase {
  label: string;
  network: WatchNetwork;
}

/**
 * A wallet defined by an extended key, as the import form hands it to the scanner before
 * any address has been derived. Saved records without a `kind` are of this kind.
 */
export interface DescriptorWalletDefinition extends WalletDefinitionBase {
  kind: 'descriptor';
  /** The raw string the user pasted (xpub/ypub/zpub/tpub/... or a BIP-380 descriptor). */
  source: string;
  /** Normalized BIP-380 multipath descriptor: index 0 = receive, 1 = change. */
  descriptor: string;
  scriptType: ScriptType | string;
  /**
   * 8 hex chars identifying the wallet.
   *
   * When `fingerprintIsMaster` is true this is the BIP-32 master fingerprint, which a
   * hardware wallet shows as its XFP. It is only knowable from a descriptor's key origin
   * (`[73c5da0a/84h/0h/0h]`) or from a depth-0 key.
   *
   * When false, it is the fingerprint of the account key that was pasted: a stable
   * identifier for this wallet that will NOT match the device's XFP, so the UI must not
   * call it a master fingerprint.
   */
  fingerprint?: string;
  fingerprintIsMaster: boolean;
  /** The real derivation path, when a descriptor told us (e.g. "m/84'/0'/0'"). */
  originPath?: string;
  gapLimit: number;
  /** Receive index the user has advanced to with "Use next address". */
  receiveIndex?: number;
}

/**
 * A fixed list of addresses with no key behind it: nothing is derived, so there is no gap
 * limit, no change chain and no next address to hand out. The addresses are stored as
 * receive-chain entries numbered in the order they were pasted.
 */
export interface AddressListWalletDefinition extends WalletDefinitionBase {
  kind: 'address-list';
  addresses: DerivedAddress[];
}

export type WalletDefinition = DescriptorWalletDefinition | AddressListWalletDefinition;

/** What a scan adds to a definition. */
interface ScannedWallet {
  id: string;
  /** How many addresses have been derived (or listed) on each chain. */
  derivedCount: Record<Chain, number>;
  addresses: DerivedAddress[];
}

/**
 * A scanned descriptor wallet, as persisted in local storage.
 *
 * `source` holds the pasted xpub/descriptor in plaintext so the gap limit can extend
 * without asking for the key again. WalletStorageService documents that trade-off.
 */
export type DescriptorWallet = DescriptorWalletDefinition & ScannedWallet;
export type AddressListWallet = AddressListWalletDefinition & ScannedWallet;
export type WatchWallet = DescriptorWallet | AddressListWallet;

/** A block, by height and hash: the server tip a wallet's history was last brought up to. */
export interface ChainTip {
  height: number;
  hash: string;
}
