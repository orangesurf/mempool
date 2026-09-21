import { Directive, EventEmitter, Input, Output } from '@angular/core';
import { WatchSectionAction } from './watch-section.types';

/**
 * Base class for every /watch section child (overview, transactions, utxos, addresses, send,
 * settings). Each receives the WatchComponent shell as `model` and reports user actions back
 * up through `action`.
 *
 * `model` is deliberately left untyped (`any`) rather than typed as `WatchComponent`. Importing
 * the shell's type here reintroduced a component↔shell import cycle — the shell's template
 * depends on the section components, the sections extend this base, and this base would depend
 * back on the shell — which Angular surfaces at runtime as a "Cannot access 'X' before
 * initialization" temporal-dead-zone error that a production build does not catch. Keeping the
 * model untyped breaks that cycle. A cleaner follow-up would be a `WatchSectionModel` interface
 * (in this file) that WatchComponent implements, giving the children type-safety without the
 * cycle.
 */
@Directive()
export abstract class WatchSectionComponent {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  @Input() model!: any;
  @Output() action = new EventEmitter<WatchSectionAction>();

  run(name: string, ...args: unknown[]): void {
    this.action.emit({ name, args });
  }
}
