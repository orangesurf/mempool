import { AddressTxSummary, Transaction } from '@interfaces/electrs.interface';
import { Bip329LabelType, DerivedAddress, WalletBalance, WalletUtxo, WatchWallet } from './watch.types';

/** One wallet's fully-computed display state, cached so switching wallets is instant. */
export interface WalletView {
  wallet: WatchWallet;
  transactions: Transaction[];
  utxos: WalletUtxo[];
  balance: WalletBalance;
  lastUsed: Record<0 | 1, number>;
  summary: AddressTxSummary[];
  truncated: boolean;
  liveTrackingDegraded: boolean;
}

export interface LabelEditor {
  type: Bip329LabelType;
  ref: string;
  walletIds: string[];
  draft: string;
}

export interface AddressExplorerRow {
  derived: DerivedAddress;
  balance: number;
  used: boolean;
  path: string;
}

export interface SendRecipientRow {
  target: string;
  amountBtc: string;
  amountBeforeMax?: string;
}

export type SendLocktimeMode = 'none' | 'absolute-height' | 'absolute-time' | 'relative-blocks' | 'relative-time';

export type WatchTab = 'overview' | 'transactions' | 'utxos' | 'addresses' | 'send' | 'settings';
