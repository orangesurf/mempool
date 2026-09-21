import {
  Base58Codec,
  buildDescriptor,
  describeScriptType,
  parseKeyOrigin,
  fromMempoolNetwork,
  keyMatchesNetwork,
  looksLikeDescriptor,
  looksLikeExtendedKey,
  normalizeExtendedKey,
  toMultipathDescriptor,
} from './watch-key.utils';

/**
 * The base58 codec and sha256 are injected into normalizeExtendedKey precisely so this can be
 * tested without loading 8.5 MB of WASM. Here we supply plain implementations.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const base58: Base58Codec = {
  decode(str: string): Uint8Array {
    let num = 0n;
    for (const ch of str) {
      const idx = ALPHABET.indexOf(ch);
      if (idx < 0) {
        throw new Error(`invalid base58 char: ${ch}`);
      }
      num = num * 58n + BigInt(idx);
    }
    const bytes: number[] = [];
    while (num > 0n) {
      bytes.unshift(Number(num & 0xffn));
      num >>= 8n;
    }
    for (const ch of str) {
      if (ch !== '1') {
        break;
      }
      bytes.unshift(0);
    }
    return new Uint8Array(bytes);
  },
  encode(bytes: Uint8Array): string {
    let num = 0n;
    for (const b of bytes) {
      num = (num << 8n) + BigInt(b);
    }
    let out = '';
    while (num > 0n) {
      out = ALPHABET[Number(num % 58n)] + out;
      num /= 58n;
    }
    for (const b of bytes) {
      if (b !== 0) {
        break;
      }
      out = '1' + out;
    }
    return out;
  },
};

const sha256 = async (data: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', data as unknown as BufferSource));

// The official BIP-84 test vector (the "abandon abandon … about" mnemonic), account 0.
const BIP84_ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
// The same key with canonical xpub version bytes — what a descriptor must be given.
const BIP84_XPUB =
  'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V';

describe('watch-key.utils', () => {
  describe('input classification', () => {
    it('recognizes extended keys', () => {
      expect(looksLikeExtendedKey(BIP84_ZPUB)).toBe(true);
      expect(looksLikeExtendedKey('not a key')).toBe(false);
    });

    it('recognizes descriptors', () => {
      expect(looksLikeDescriptor('wpkh(xpub.../<0;1>/*)')).toBe(true);
      expect(looksLikeDescriptor('sh(wpkh(xpub.../0/*))')).toBe(true);
      expect(looksLikeDescriptor(BIP84_ZPUB)).toBe(false);
    });
  });

  describe('normalizeExtendedKey', () => {
    it('rewrites a zpub to a canonical xpub and recovers the script type', async () => {
      const norm = await normalizeExtendedKey(BIP84_ZPUB, base58, sha256);
      expect(norm.xpub).toBe(BIP84_XPUB);
      expect(norm.scriptType).toBe('wpkh');
      expect(norm.keyNetwork).toBe('mainnet');
    });

    it('leaves a canonical xpub unchanged', async () => {
      const norm = await normalizeExtendedKey(BIP84_XPUB, base58, sha256);
      expect(norm.xpub).toBe(BIP84_XPUB);
      expect(norm.keyNetwork).toBe('mainnet');
    });

    it('rejects a key with a corrupted checksum rather than deriving a stranger’s wallet', async () => {
      // Flip one character in the body. Without the checksum guard this would silently
      // produce valid-looking addresses belonging to nobody.
      const corrupted = BIP84_ZPUB.slice(0, 20) + (BIP84_ZPUB[20] === 'a' ? 'b' : 'a') + BIP84_ZPUB.slice(21);
      await expectAsyncThrow(() => normalizeExtendedKey(corrupted, base58, sha256), /checksum/i);
    });

    it('rejects an unknown prefix', async () => {
      await expectAsyncThrow(() => normalizeExtendedKey('qpub123', base58, sha256), /prefix/i);
    });
  });

  describe('buildDescriptor', () => {
    it('wraps each script type correctly, always multipath', () => {
      expect(buildDescriptor('XPUB', 'wpkh')).toBe('wpkh(XPUB/<0;1>/*)');
      expect(buildDescriptor('XPUB', 'pkh')).toBe('pkh(XPUB/<0;1>/*)');
      expect(buildDescriptor('XPUB', 'sh_wpkh')).toBe('sh(wpkh(XPUB/<0;1>/*))');
      expect(buildDescriptor('XPUB', 'tr')).toBe('tr(XPUB/<0;1>/*)');
    });
  });

  describe('toMultipathDescriptor', () => {
    it('rewrites a single-path descriptor so we get the change chain too', () => {
      expect(toMultipathDescriptor('wpkh(xpub/0/*)')).toBe('wpkh(xpub/<0;1>/*)');
    });

    it('leaves an already-multipath descriptor alone', () => {
      expect(toMultipathDescriptor('wpkh(xpub/<0;1>/*)')).toBe('wpkh(xpub/<0;1>/*)');
    });


    it('rewrites every cosigner branch in a multisig descriptor', () => {
      expect(toMultipathDescriptor('wsh(sortedmulti(2,xpubA/0/*,xpubB/0/*))'))
        .toBe('wsh(sortedmulti(2,xpubA/<0;1>/*,xpubB/<0;1>/*))');
    });

    it('rejects a stale or mistyped descriptor checksum', () => {
      expect(() => toMultipathDescriptor('wpkh(xpub/<0;1>/*)#abcd1234')).toThrowError(/checksum is invalid/);
    });

    it('accepts a valid BIP-380 checksum', () => {
      expect(toMultipathDescriptor('raw(deadbeef)#89f8spxm')).toBe('raw(deadbeef)');
    });
  });

  describe('parseKeyOrigin', () => {
    it('extracts the master fingerprint and path from a descriptor', () => {
      const origin = parseKeyOrigin("wpkh([73c5da0a/84h/0h/0h]xpub6C.../<0;1>/*)");
      expect(origin!.masterFingerprint).toBe('73c5da0a');
      expect(origin!.path).toBe("m/84'/0'/0'");
    });

    it('accepts apostrophe-hardened paths too', () => {
      const origin = parseKeyOrigin("wpkh([73C5DA0A/84'/0'/0']xpub6C.../<0;1>/*)");
      expect(origin!.masterFingerprint).toBe('73c5da0a');
      expect(origin!.path).toBe("m/84'/0'/0'");
    });

    it('returns null for a descriptor with no key origin', () => {
      expect(parseKeyOrigin('wpkh(xpub6C.../<0;1>/*)')).toBeNull();
    });

    // This is the whole reason the wallet distinguishes master from key fingerprint: a bare
    // extended key simply does not carry a master fingerprint, and claiming otherwise would
    // print a value that does not match the user's hardware wallet XFP.
    it('returns null for a bare extended key', () => {
      expect(parseKeyOrigin(BIP84_ZPUB)).toBeNull();
    });
  });

  describe('describeScriptType', () => {
    it('renders our SLIP-132 script types legibly', () => {
      expect(describeScriptType('wpkh').name).toBe('Native SegWit');
      expect(describeScriptType('wpkh').code).toBe('P2WPKH');
      expect(describeScriptType('wpkh').path).toBe("m/84'/0'/0'");
      expect(describeScriptType('sh_wpkh').code).toBe('P2SH-P2WPKH');
      expect(describeScriptType('tr').name).toBe('Taproot');
    });

    // btcd's DescType is capitalised ('Wpkh'), ours is not ('wpkh'). Both reach the UI, so
    // both must render the same.
    it('normalizes btcd DescType capitalisation', () => {
      expect(describeScriptType('Wpkh').name).toBe('Native SegWit');
      expect(describeScriptType('ShWpkh').code).toBe('P2SH-P2WPKH');
      expect(describeScriptType('Tr').name).toBe('Taproot');
    });

    it('offers no standard path for script descriptors, which have none', () => {
      expect(describeScriptType('Wsh').path).toBe(undefined);
      expect(describeScriptType('Wsh').code).toBe('P2WSH');
    });
  });

  describe('network guards', () => {
    it('maps mempool network ids, rejecting unsupported ones', () => {
      expect(fromMempoolNetwork('')).toBe('mainnet');
      expect(fromMempoolNetwork('testnet4')).toBe('testnet4');
      expect(fromMempoolNetwork('signet')).toBe('signet');
      expect(fromMempoolNetwork('liquid')).toBe(null);
    });

    it('refuses a mainnet key on a testnet page (which would look like an empty wallet)', () => {
      expect(keyMatchesNetwork('mainnet', 'mainnet')).toBe(true);
      expect(keyMatchesNetwork('mainnet', 'testnet4')).toBe(false);
      expect(keyMatchesNetwork('testnet', 'signet')).toBe(true);
      expect(keyMatchesNetwork('testnet', 'mainnet')).toBe(false);
    });
  });
});

/** Small helper so the async-throw assertions read the same under any runner. */
async function expectAsyncThrow(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let threw: Error | null = null;
  try {
    await fn();
  } catch (e) {
    threw = e as Error;
  }
  expect(threw).not.toBeNull();
  expect(pattern.test(threw!.message)).toBe(true);
}
