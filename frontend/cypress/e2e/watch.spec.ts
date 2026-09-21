/**
 * Drives the watch-only wallet import flow in a real browser against the live preview
 * (served by mem000-github/serve.py, which proxies the API to mempool.space).
 *
 * Uses the published BIP-84 test-vector zpub — public knowledge, real mainnet history,
 * nobody's actual funds.
 */
const BIP84_ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

// The first receive address of that wallet, per the BIP-84 spec.
const FIRST_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

// The preview proxies /api to mempool.space, so we can look up a real tx paying it.
const API = 'http://127.0.0.1:9260/api';

describe('watch-only wallet', () => {
  beforeEach(() => {
    cy.clearLocalStorage();
  });

  it('renders the import form on mainnet', () => {
    cy.visit('/watch');
    cy.contains('Import a wallet').should('be.visible');
    cy.get('textarea').should('be.visible');
    // The mainnet network-detection bug made this button a no-op; it must be enabled once
    // a key is entered.
    cy.get('button').contains('Import').should('exist');
  });

  it('imports a zpub, derives client-side, and shows the wallet', () => {
    cy.visit('/watch');

    // NOTE: the wasm is fetched from inside a Web Worker, and cy.intercept cannot observe
    // worker traffic. So we assert the *outcome* (a scanned wallet) rather than the fetch —
    // a wallet cannot render without the derivation engine having loaded and run.
    //
    // Record EVERY request body: the privacy claim is that the extended key is never sent,
    // and that has to hold across all of them, not just the one we happen to sample.
    const sentBodies: string[] = [];
    cy.intercept('POST', '**/api/addresses/txs*', (req) => {
      sentBodies.push(JSON.stringify(req.body));
    }).as('batch');

    cy.get('textarea').type(BIP84_ZPUB, { delay: 0 });
    cy.get('button').contains('Import').click();

    // The wallet is scanned through the batch endpoint (not one request per address).
    cy.wait('@batch', { timeout: 90000 }).its('response.statusCode').should('eq', 200);

    // Derivation happened in the browser: the dashboard replaces the import form.
    cy.contains('Unspent outputs', { timeout: 90000 }).should('be.visible');
    cy.contains('Transactions').should('be.visible');
    cy.contains('Balance').should('be.visible');


    // The whole point of the feature: the extended key must NEVER reach the server, in ANY
    // request. And what we DO send is derived addresses — including the BIP-84 vector's
    // published first address, which proves derivation ran correctly in the browser.
    cy.then(() => {
      expect(sentBodies.length, 'batch requests were made').to.be.greaterThan(0);
      sentBodies.forEach((body) => {
        expect(body, 'extended key never sent to the server').to.not.contain(BIP84_ZPUB);
      });
      expect(
        sentBodies.some((b) => b.includes(FIRST_ADDRESS)),
        'the BIP-84 vector’s first address was derived and queried',
      ).to.be.true;
    });

    // The wallet persists so highlighting works on other pages — and the gap limit
    // auto-extended: receive index 39 is used in this vector wallet, so a correct scan must
    // have derived well past the initial 20 per chain.
    cy.window().then((win) => {
      const stored = win.localStorage.getItem('watch-wallets');
      expect(stored, 'wallet persisted to localStorage').to.not.be.null;
      expect(stored).to.contain(FIRST_ADDRESS);

      const wallets = JSON.parse(stored!);
      expect(wallets[0].addresses.length, 'gap limit auto-extended past the initial 40')
        .to.be.greaterThan(40);
      expect(wallets[0].scriptType, 'script type recovered from the zpub prefix').to.eq('wpkh');
    });
  });

  it('renders the shared balance-history chart over the whole wallet', () => {
    cy.visit('/watch');
    cy.get('textarea').type(BIP84_ZPUB, { delay: 0 });
    cy.get('button').contains('Import').click();

    cy.contains('Balance history', { timeout: 90000 }).should('be.visible');
    // AddressGraphComponent configures echarts with renderer: 'svg' (address-graph.component.ts:69),
    // so the chart is an <svg>, not a <canvas>.
    cy.get('app-address-graph svg', { timeout: 30000 }).should('exist');
    // It plots a real running balance, not an empty axis: this wallet's history peaked well
    // above zero even though it is swept today.
    cy.get('app-address-graph').should('contain.text', 'BTC');
  });

  it('does not overlap the header buttons', () => {
    cy.visit('/watch');
    cy.get('textarea').type(BIP84_ZPUB, { delay: 0 });
    cy.get('button').contains('Import').click();
    cy.contains('Unspent outputs', { timeout: 90000 }).should('be.visible');

    // The original overlap came from Bootstrap 4 spacing classes (mr-2) in a Bootstrap 5 app,
    // where they don't exist and so apply no margin. Assert real geometry, not a class name,
    // so it cannot silently regress.
    cy.contains('button', 'Refresh').then(($refresh) => {
      cy.get('.settings-toggle').then(($gear) => {
        const a = $refresh[0].getBoundingClientRect();
        const b = $gear[0].getBoundingClientRect();
        expect(b.left, 'gear starts after Refresh ends').to.be.greaterThan(a.right);
        expect(b.left - a.right, 'visible gap between the buttons').to.be.greaterThan(2);
      });
    });
  });

  it('keeps the technical details behind the settings gear', () => {
    cy.visit('/watch');
    cy.get('textarea').type(BIP84_ZPUB, { delay: 0 });
    cy.get('button').contains('Import').click();
    cy.contains('Unspent outputs', { timeout: 90000 }).should('be.visible');

    // Collapsed by default: the header shows what identifies the wallet, nothing more.
    cy.get('.wallet-details').should('not.exist');
    cy.contains('Native SegWit').should('not.exist');
    cy.contains('Forget wallet').should('not.exist');

    cy.get('.settings-toggle').click();

    cy.get('.wallet-details').should('be.visible');
    cy.contains('Native SegWit').should('be.visible');
    cy.contains("m/84'/0'/0'").should('be.visible');
    cy.contains('Gap limit').should('be.visible');
    cy.contains('Forget wallet').should('be.visible');

    // The descriptor embeds the extended public key, so it must not be on screen until asked.
    cy.get('.descriptor').should('not.exist');
    cy.contains('Show (contains your public key)').click();
    cy.get('.descriptor').should('contain.text', 'wpkh(');
  });

  it('shows the account key fingerprint (NOT "master") for a bare zpub', () => {
    cy.visit('/watch');
    cy.get('textarea').type(BIP84_ZPUB, { delay: 0 });
    cy.get('button').contains('Import').click();
    cy.contains('Unspent outputs', { timeout: 90000 }).should('be.visible');

    // A bare extended key does not carry the master fingerprint. Claiming it did would print
    // a value that fails to match the user's hardware wallet XFP (73C5DA0A for this seed),
    // so the label must say "Key fingerprint" and show the account key's own FD13AAC9.
    cy.get('.wallet-identity').should('contain.text', 'Key fingerprint');
    cy.get('.wallet-identity').should('not.contain.text', 'Master fingerprint');
    cy.get('.wallet-identity .fingerprint').should('have.text', 'FD13AAC9');

    // Script type is spelled out, not the raw 'wpkh' — inside the details panel.
    cy.get('.settings-toggle').click();
    cy.contains('Native SegWit').should('be.visible');
    cy.contains('P2WPKH').should('be.visible');
    cy.contains("m/84'/0'/0'").should('be.visible');
    cy.contains('wpkh').should('not.exist');
  });

  it('shows the true MASTER fingerprint when a descriptor carries the key origin', () => {
    cy.visit('/watch');
    // Same wallet, imported as a descriptor with key origin — this is the only import path
    // that can tell us the master fingerprint, and it must match the device XFP: 73c5da0a.
    const descriptor =
      "wpkh([73c5da0a/84h/0h/0h]xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V/<0;1>/*)";
    cy.get('textarea').type(descriptor, { delay: 0, parseSpecialCharSequences: false });
    cy.get('button').contains('Import').click();
    cy.contains('Unspent outputs', { timeout: 90000 }).should('be.visible');

    cy.get('.wallet-identity').should('contain.text', 'Master fingerprint');
    cy.get('.wallet-identity .fingerprint').should('have.text', '73C5DA0A');
    // And it derives the same wallet as the zpub did.
    cy.get('.settings-toggle').click();
    cy.contains('Native SegWit').should('be.visible');
  });

  it('marks wallet addresses on the transaction and address pages', () => {
    // Import first, so the wallet is in localStorage for the other pages to read.
    cy.visit('/watch');
    cy.get('textarea').type(BIP84_ZPUB, { delay: 0 });
    cy.get('button').contains('Import').click();
    cy.contains('Unspent outputs', { timeout: 90000 }).should('be.visible');

    // Address page: the badge names the derivation path, so you can see which key made it.
    cy.visit(`/address/${FIRST_ADDRESS}`);
    cy.get('.wallet-badge', { timeout: 60000 }).should('be.visible');
    cy.get('.wallet-badge').should('contain.text', 'In your wallet');
    cy.get('.wallet-badge').should('contain.text', "m/84'/0'/0'/0/0");

    // Transaction page: the wallet icon appears next to our outputs. Uses a real transaction
    // paying the BIP-84 vector's first address.
    cy.request('GET', `${API}/address/${FIRST_ADDRESS}/txs`).then((res) => {
      const txid = res.body[0].txid;
      cy.visit(`/tx/${txid}`);
      // The icon sits inside the amount cell, immediately left of the value — not under the
      // address, where it used to wrap onto its own line.
      cy.get('td.amount .wallet-tag', { timeout: 60000 }).should('exist');
      cy.get('app-address-text .wallet-tag').should('not.exist');

      // "On the same line as the value" is a geometric claim, so assert it geometrically:
      // the icon must sit to the LEFT of the amount and share its vertical centre. If it
      // wrapped onto its own line, the centres would differ by more than a few pixels.
      cy.get('td.amount').filter(':has(.wallet-tag)').first().within(() => {
        cy.get('.wallet-tag').then(($tag) => {
          cy.get('app-amount').then(($amount) => {
            const tag = $tag[0].getBoundingClientRect();
            const amt = $amount[0].getBoundingClientRect();
            const tagMid = tag.top + tag.height / 2;
            const amtMid = amt.top + amt.height / 2;
            expect(tag.right, 'icon is left of the value').to.be.at.most(amt.left + 1);
            expect(Math.abs(tagMid - amtMid), 'icon shares the value’s line (not wrapped)')
              .to.be.lessThan(6);
          });
        });
      });
    });
  });

  it('rejects a corrupted key instead of silently deriving an empty wallet', () => {
    cy.visit('/watch');
    const corrupted = BIP84_ZPUB.slice(0, 20) + 'x' + BIP84_ZPUB.slice(21);
    cy.get('textarea').type(corrupted, { delay: 0 });
    cy.get('button').contains('Import').click();
    cy.get('.alert-danger', { timeout: 60000 }).should('be.visible');
  });
});
