/**
 * Plain address lists: splitting, the cheap shape check the import form uses, and
 * validation.
 *
 * Free of Angular and of any Bitcoin library, so the main bundle can use the shape check.
 * Checksum validation needs @scure/btc-signer, which only the derivation worker loads; it
 * passes its decoder in.
 */

import { InputError } from '@app/watch/derivation.messages';
import { WatchNetwork } from '@app/watch/watch.types';

/**
 * Upper bound on a pasted list. Each address is sent to the server with every refresh, so a
 * list this long already means several batched requests per scan.
 */
const MAX_LISTED_ADDRESSES = 1000;

/** Rough shape of a bech32/bech32m or base58 Bitcoin address; checksums are checked later. */
const ADDRESS_SHAPE_RE = /^(?:(?:bc|tb|bcrt)1[02-9ac-hj-np-z]{8,87}|[123mn][1-9A-HJ-NP-Za-km-z]{25,34})$/i;

interface ListedEntry {
  /** 1-based line of the pasted text the entry came from. */
  line: number;
  value: string;
}

/** One entry per address, in the order pasted. Lines may also be split by commas or spaces. */
function splitAddressList(input: string): ListedEntry[] {
  const entries: ListedEntry[] = [];
  input.split(/\r?\n/).forEach((text, i) => {
    for (const value of text.split(/[\s,;]+/)) {
      if (value) {
        entries.push({ line: i + 1, value });
      }
    }
  });
  return entries;
}

/**
 * True if the input reads as an address list rather than a key or descriptor: its first
 * entry is address-shaped. A list with a bad entry further down still counts, so the
 * import reports that entry instead of calling the whole input unrecognized.
 */
export function looksLikeAddressList(input: string): boolean {
  const first = splitAddressList(input)[0];
  return !!first && ADDRESS_SHAPE_RE.test(first.value);
}

/** Number of distinct entries, for the import form's hint. Case-insensitive, as bech32 is. */
export function countListedAddresses(input: string): number {
  return new Set(splitAddressList(input).map((e) => normalizeCase(e.value))).size;
}

/** Bech32 is case-insensitive and the API returns lower case; base58 is case-sensitive. */
function normalizeCase(value: string): string {
  return /^(?:bc|tb|bcrt)1/i.test(value) ? value.toLowerCase() : value;
}

/**
 * Decodes an address for one address family and returns its canonical form and locking
 * script, or throws if the address is not valid for that family.
 */
export type AddressDecoder = (address: string, family: 'mainnet' | 'testnet') => { address: string; scriptPubKey: string };

/**
 * Validate a pasted list for one network and return its distinct addresses in the order
 * pasted. Throws an InputError naming the first entry that is not usable.
 */
export function parseAddressList(input: string, network: WatchNetwork, decode: AddressDecoder): { address: string; scriptPubKey: string }[] {
  const family = network === 'mainnet' ? 'mainnet' : 'testnet';
  const other = family === 'mainnet' ? 'testnet' : 'mainnet';
  const seen = new Set<string>();
  const addresses: { address: string; scriptPubKey: string }[] = [];

  for (const { line, value } of splitAddressList(input)) {
    let decoded: { address: string; scriptPubKey: string };
    try {
      decoded = decode(normalizeCase(value), family);
    } catch {
      let otherNetwork = false;
      try {
        decode(normalizeCase(value), other);
        otherNetwork = true;
      } catch {
        // Not valid anywhere; reported below.
      }
      throw otherNetwork
        ? new InputError('address-other-network', { line, address: value, addressNetwork: other, network })
        : new InputError('address-invalid', { line, address: value });
    }
    if (!seen.has(decoded.address)) {
      seen.add(decoded.address);
      addresses.push(decoded);
    }
  }

  if (!addresses.length) {
    throw new InputError('address-list-empty');
  }
  if (addresses.length > MAX_LISTED_ADDRESSES) {
    throw new InputError('address-list-too-long', { max: MAX_LISTED_ADDRESSES, count: addresses.length });
  }
  return addresses;
}
