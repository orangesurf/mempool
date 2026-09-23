import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';

@Component({
  selector: 'app-wallet-label-editor',
  templateUrl: './wallet-label-editor.component.html',
  styleUrls: ['./wallet-label-editor.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class WalletLabelEditorComponent implements OnChanges {
  @Input() value = '';
  @Input() prefix = '';
  @Input() placeholder = 'Add label';
  @Input() ariaLabel = 'Wallet label';
  @Input() maxLength = 200;

  @Output() draftChange = new EventEmitter<string>();
  @Output() saved = new EventEmitter<string>();
  @Output() focusChange = new EventEmitter<boolean>();

  draft = '';
  focused = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.value && !this.focused) {
      this.draft = this.value || '';
    }
  }

  onFocus(): void {
    this.focused = true;
    this.focusChange.emit(true);
  }

  onInput(value: string): void {
    this.draft = value;
    this.draftChange.emit(value);
  }

  onBlur(): void {
    this.focused = false;
    const value = this.draft.trim();
    this.draft = value;
    this.saved.emit(value);
    this.focusChange.emit(false);
  }

  commit(input: HTMLInputElement): void {
    input.blur();
  }

  cancel(input: HTMLInputElement): void {
    this.draft = this.value || '';
    this.draftChange.emit(this.draft);
    input.blur();
  }
}
