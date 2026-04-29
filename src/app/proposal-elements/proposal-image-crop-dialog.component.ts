import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  ViewChild,
  inject,
  input,
  output
} from '@angular/core';

@Component({
  selector: 'proposal-image-crop-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './proposal-image-crop-dialog.component.html',
  styleUrl: './proposal-image-crop-dialog.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProposalImageCropDialogComponent {
  private readonly cdr = inject(ChangeDetectorRef);

  readonly sourceUrl = input.required<string>();

  readonly dismissed = output<void>();
  readonly confirmed = output<{ dataUrl: string; mime: string }>();

  @ViewChild('cropImg') protected readonly cropImg?: ElementRef<HTMLImageElement>;

  protected sel: { nx: number; ny: number; nw: number; nh: number } | null = null;
  protected dragCornerA: { nx: number; ny: number } | null = null;

  /** True while LMB/touch marquee is updating. */

  protected dragActive = false;

  protected onImgLoad() {
    const i = 0.035;

    this.sel = {
      nx: i,
      ny: i,

      nw: 1 - i * 2,

      nh: 1 - i * 2
    };

    this.cdr.markForCheck();
  }

  protected backdropClick(ev: Event) {
    if (ev.target === ev.currentTarget) this.dismissed.emit();
  }

  protected onPointerDown(ev: PointerEvent) {

    const nx = this.normX(ev);

    const ny = this.normY(ev);


    if (nx === null || ny === null) return;

    ev.preventDefault();

    ev.stopPropagation();


    this.dragCornerA = { nx, ny };

    this.dragActive = true;


    ev.currentTarget && (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);


    this.onPointerMove(ev);


    this.cdr.markForCheck();
  }

  protected onPointerMove(ev: PointerEvent) {


    const nx = this.normX(ev);


    const ny = this.normY(ev);


    if (!this.dragCornerA || !this.dragActive || nx === null || ny === null) return;


    const xa = Math.min(this.dragCornerA.nx, nx);


    const ya = Math.min(this.dragCornerA.ny, ny);


    const bw = Math.abs(nx - this.dragCornerA.nx);


    const bh = Math.abs(ny - this.dragCornerA.ny);

    let nxLo = xa;

    let nyLo = ya;

    let nw = bw;

    let nh = bh;

    const minF = 0.025;

    nw = Math.max(minF, nw);

    nh = Math.max(minF, nh);

    nxLo = Math.max(0, Math.min(nxLo, 1 - nw));

    nyLo = Math.max(0, Math.min(nyLo, 1 - nh));

    nw = Math.min(nw, 1 - nxLo);


    nh = Math.min(nh, 1 - nyLo);


    this.sel = { nx: nxLo, ny: nyLo, nw, nh };


    this.cdr.markForCheck();
  }

  protected onPointerEnd(ev: PointerEvent) {

    this.dragActive = false;


    this.dragCornerA = null;


    try {
      (ev.currentTarget as HTMLElement)?.releasePointerCapture(ev.pointerId);
    } catch {


      /**/

    }


    this.cdr.markForCheck();
  }


  protected applyCrop() {
    const img = this.cropImg?.nativeElement;


    let rect = this.sel;


    if (!img || !rect || img.naturalWidth === 0 || img.naturalHeight === 0) return;


    if (!rect!.nw || !rect!.nh) return;


    const sx = rect!.nx * img.naturalWidth;

    const sy = rect!.ny * img.naturalHeight;

    const sw = rect!.nw * img.naturalWidth;

    const sh = rect!.nh * img.naturalHeight;

    const canvas = document.createElement('canvas');


    canvas.width = Math.max(1, Math.round(sw));

    canvas.height = Math.max(1, Math.round(sh));


    const ctx = canvas.getContext('2d');

    if (!ctx) return;

    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);


    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);


    this.confirmed.emit({ dataUrl, mime: 'image/jpeg' });
  }


  private normX(ev: PointerEvent): number | null {
    const img = this.cropImg?.nativeElement;


    if (!img || img.naturalWidth === 0) return null;


    const r = img.getBoundingClientRect();


    let x = (ev.clientX - r.left) / r.width;


    return Math.max(0, Math.min(1, x));
  }

  private normY(ev: PointerEvent): number | null {
    const img = this.cropImg?.nativeElement;


    if (!img || img.naturalHeight === 0) return null;


    const r = img.getBoundingClientRect();


    let y = (ev.clientY - r.top) / r.height;


    return Math.max(0, Math.min(1, y));
  }
}
