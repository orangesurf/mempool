import { Component, Input, AfterViewInit, ViewChild, ElementRef, ChangeDetectionStrategy } from '@angular/core';
import * as QRCode from 'qrcode';
import { StateService } from '@app/services/state.service';

@Component({
  selector: 'app-qrcode',
  templateUrl: './qrcode.component.html',
  styleUrls: ['./qrcode.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QrcodeComponent implements AfterViewInit {
  @Input() data: string;
  @Input() size = 125;
  @Input() imageUrl: string;
  @Input() border = 0;
  /** QR quiet zone in modules. Animated/signing QRs should use the standard four modules. */
  @Input() margin = 0;
  @ViewChild('canvas') canvas: ElementRef;

  qrcodeObject: any;

  constructor(
    private stateService: StateService,
  ) { }

  ngOnChanges() {
    if (!this.canvas || !this.canvas.nativeElement) {
      return;
    }
    this.render();
  }

  ngAfterViewInit() {
    this.render();
  }

  render() {
    if (!this.stateService.isBrowser) {
      return;
    }
    const opts: QRCode.QRCodeRenderersOptions = {
      errorCorrectionLevel: 'M',
      margin: this.margin,
      color: {
        dark: '#000',
        light: '#fff'
      },
      width: this.size,
    };

    if (!this.data) {
      return;
    }

    let address = this.data;
    if (/^(?:bc1|tb1|bcrt1|ur:)/i.test(address)) address = address.toUpperCase();

    QRCode.toCanvas(this.canvas.nativeElement, address, opts, (error: any) => {
      if (error) {
         console.error(error);
      }
    });
  }
}
