import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import type { ProposalElementPosition } from '../models/proposal-element.model';

@Component({
  selector: 'proposal-element-shell',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './proposal-element-shell.component.html',
  styleUrl: './proposal-element-shell.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[style.left.px]': 'position().x',
    '[style.top.px]': 'position().y',
    '[style.width.px]': 'position().width',
    '[style.height.px]': 'position().height',
    '[style.zIndex]': 'position().zIndex',
    '[style.transform]': '"rotate(" + (position().rotation ?? 0) + "deg)"',
    class: 'proposalShellHost'
  }
})
export class ProposalElementShellComponent {
  private readonly grid = 8;
  readonly frameWidthPx = input(920);
  readonly frameHeightPx = input(520);

  readonly position = input.required<ProposalElementPosition>();
  readonly shellLabel = input('');
  readonly selected = input(false);
  readonly interactive = input(true);

  readonly patchPosition = output<ProposalElementPosition>();
  readonly activate = output<void>();

  private drag:
    | {
        kind: 'move';
        ptr0: number;
        ptr1: number;
        x0: number;
        y0: number;
        w0: number;
        h0: number;
      }
    | {
        kind: 'resize';
        ptr0: number;
        ptr1: number;
        bx: number;
        by: number;
        bw: number;
        bh: number;
      }
    | null = null;

  protected chromeDown(ev: PointerEvent) {
    if (!this.interactive()) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.activate.emit();
    const p = this.position();
    this.drag = {
      kind: 'move',
      ptr0: ev.clientX,
      ptr1: ev.clientY,
      x0: p.x,
      y0: p.y,
      w0: p.width,
      h0: p.height
    };
    ev.currentTarget && (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }

  protected resizeDown(ev: PointerEvent) {
    if (!this.interactive()) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.activate.emit();
    const p = this.position();
    this.drag = {
      kind: 'resize',
      ptr0: ev.clientX,
      ptr1: ev.clientY,
      bx: p.x,
      by: p.y,
      bw: p.width,
      bh: p.height
    };
    ev.currentTarget && (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }

  protected move(ev: PointerEvent) {
    const d = this.drag;
    if (!d || !this.interactive()) return;

    const fw = this.frameWidthPx();
    const fh = this.frameHeightPx();
    const min = 56;

    if (d.kind === 'move') {
      const nx = snap(clamp(d.x0 + ev.clientX - d.ptr0, 0, Math.max(0, fw - d.w0)), this.grid);
      const ny = snap(clamp(d.y0 + ev.clientY - d.ptr1, 0, Math.max(0, fh - d.h0)), this.grid);
      this.patchPosition.emit({ ...this.position(), x: nx, y: ny });
      return;
    }

    let nw = d.bw + (ev.clientX - d.ptr0);
    let nh = d.bh + (ev.clientY - d.ptr1);
    nw = snap(Math.max(min, Math.min(fw - d.bx, nw)), this.grid);
    nh = snap(Math.max(min, Math.min(fh - d.by, nh)), this.grid);
    this.patchPosition.emit({
      ...this.position(),
      x: d.bx,
      y: d.by,
      width: nw,
      height: nh
    });
  }

  protected end(ev: PointerEvent) {
    this.drag = null;
    try {
      (ev.currentTarget as HTMLElement | null)?.releasePointerCapture(ev.pointerId);
    } catch {
      /* no-op */
    }
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function snap(n: number, unit: number) {
  if (unit <= 1) return n;
  return Math.round(n / unit) * unit;
}
