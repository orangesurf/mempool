import { AddressTxSummary, Transaction, Utxo } from '@interfaces/electrs.interface';
import { BehaviorSubject } from 'rxjs';
import { Bip329LabelType, DerivedAddress, WalletBalance, WalletUtxo, WatchWallet } from '../watch.types';

import { AddressExplorerRow, WatchTab } from '../watch-models';

/** Tab contracts contain only the state and callbacks each template uses. */
export interface WatchSettingsModel {
  acknowledgeDescriptorOrigin: () => void;
  beginWalletFileImport: (event: Event) => Promise<void>;
  cancelRename: () => void;
  derivationPathLabel: string | null;
  descriptorOriginAcknowledged: boolean;
  editingLabel: boolean;
  error: string | null;
  exportDescriptor: () => void;
  exportLabels: () => void;
  exportSparrow: () => void;
  exportTransactionsCsv: () => void;
  exportTransferMessage: string;
  exportUtxosCsv: () => void;
  forget: () => void;
  importLabels: (event: Event) => Promise<void>;
  labelDraft: string;
  labelTransferMessage: string;
  needsSigningDescriptor: boolean;
  saveRename: () => void;
  scanning: boolean;
  scriptTypeCode: string;
  scriptTypeName: string;
  setShowAddressDerivationPath: (show: boolean) => void;
  settingsGapLimit: number;
  showAddressDerivationPath: boolean;
  startRename: () => void;
  transactions: Transaction[];
  updateGapLimit: () => Promise<void>;
  wallet: WatchWallet | null;
  walletFileMessage: string;
}

export interface WatchTransactionsModel {
  acceleratedTxids: Set<string> | null;
  addressStrings: string[];
  openWalletAddress: (address: string) => void;
  scanning: boolean;
  setTxLabel: (txid: string, label: string) => void;
  transactions: Transaction[];
  txLabelMap: Record<string, string>;
  viewingAll: boolean;
}

export interface WatchAddressesModel {
  addressBalanceFilter: 'all' | 'positive';
  addressBalanceSort: 'none' | 'desc' | 'asc';
  addressChainFilter: 'all' | 'receive' | 'change';
  addressDisplayLabel: (address: string) => string;
  addressStats: { total: number; used: number; withBalance: number; };
  addressStatusFilter: 'all' | 'unused' | 'used';
  addressTransactionLabels: (address: string) => string[];
  cycleAddressBalanceFilter: () => void;
  cycleAddressBalanceSort: () => void;
  cycleAddressStatusFilter: () => void;
  highlightedAddress: string;
  labelFor: (type: Bip329LabelType, ref: string) => string;
  setInlineLabel: (type: Bip329LabelType, ref: string, label: string) => void;
  showAddressDerivationPath: boolean;
  trackByAddress: (_: number, row: AddressExplorerRow) => string;
  visibleAddressRows: AddressExplorerRow[];
}

export interface WatchUtxosModel {
  graphFrozenOutpoints: Set<string>;
  graphLabelSlots: Set<string>;
  graphUtxoLabelDetails: Record<string, string[]>;
  graphUtxoLabels: Record<string, string>;
  graphUtxos: Utxo[];
  isFrozen: (utxo: WalletUtxo) => boolean;
  labelFor: (type: Bip329LabelType, ref: string) => string;
  outpoint: (utxo: Pick<WalletUtxo, 'txid' | 'vout'>) => string;
  setInlineLabel: (type: Bip329LabelType, ref: string, label: string) => void;
  setUtxoLabelDraft: (ref: string, label: string) => void;
  setUtxoLabelFocus: (ref: string, focused: boolean) => void;
  toggleFrozen: (utxo: WalletUtxo) => void;
  trackByUtxo: (_: number, utxo: WalletUtxo) => string;
  utxoInheritedLabel: (utxo: WalletUtxo) => string;
  utxos: WalletUtxo[];
}

export interface WatchOverviewModel {
  absoluteSats: (value: number) => number;
  acceleratedTxids: Set<string> | null;
  advanceReceiveAddress: () => void;
  balance: WalletBalance;
  currentReceiveAddress: DerivedAddress | null;
  error: string | null;
  initialWalletLoading: boolean;
  labelFor: (type: Bip329LabelType, ref: string) => string;
  liveTrackingDegraded: boolean;
  openWalletTab: (tab: WatchTab) => void;
  receiveDerivationPath: (address: DerivedAddress) => string;
  recentTransactionValues: Record<string, number>;
  recentTransactions: Transaction[];
  refresh: (expectedGeneration?: number) => Promise<void>;
  scanning: boolean;
  setInlineLabel: (type: Bip329LabelType, ref: string, label: string) => void;
  transactions: Transaction[];
  truncated: boolean;
  upcomingReceiveAddresses: DerivedAddress[];
  viewingAll: boolean;
  walletLoadingTitle: string;
  walletSummary$: BehaviorSubject<AddressTxSummary[]>;
}

export interface WatchSendModel {
  descriptorOriginAcknowledged: boolean;
  graphUtxoLabelDetails: Record<string, string[]>;
  graphUtxoLabels: Record<string, string>;
  hasFrozenUtxos: boolean;
  openWalletTab: (tab: WatchTab) => void;
}
