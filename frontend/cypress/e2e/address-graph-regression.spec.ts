/**
 * Regression guard for extracting AddressGraphComponent out of GraphsModule into its own
 * module (so the watch-only wallet could reuse it). The address page is the component's
 * original home and the most likely thing to break.
 */
describe('address page balance graph (after AddressGraphModule extraction)', () => {
  it('still renders the balance history chart', () => {
    cy.visit('/address/bc1qy28ymt58g5vp9pnhqfawpcle4hgwfhapuq6ufu');
    cy.get('app-address-graph', { timeout: 60000 }).should('exist');
    cy.get('app-address-graph svg', { timeout: 60000 }).should('exist');
  });
});
