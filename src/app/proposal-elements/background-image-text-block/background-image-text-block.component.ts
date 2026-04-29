import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type {
  ProposalBackgroundImageTextContent,
  ProposalBackgroundImageTextStyle,
  ProposalTextRichContent
} from '../models/proposal-element.model';
import { TextBlockComponent } from '../text-block/text-block.component';

@Component({
  selector: 'proposal-background-image-text-block',
  standalone: true,
  imports: [CommonModule, TextBlockComponent],
  templateUrl: './background-image-text-block.component.html',
  styleUrl: './background-image-text-block.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BackgroundImageTextBlockComponent {
  readonly content = input.required<ProposalBackgroundImageTextContent>();
  readonly presentation = input.required<ProposalBackgroundImageTextStyle>();
  readonly textEditable = input(false);

  readonly htmlPatch = output<string>();

  protected readonly body = computed<ProposalTextRichContent>(() => ({
    html: this.content().overlayHtml ?? '<p>&#8203;</p>'
  }));

  protected readonly imgFit = computed(() => this.presentation().backgroundSize ?? 'cover');

  /** Darkening wash for contrast — extend with full hex parsing if needed. */
  protected readonly tintStyle = computed(() => {
    const overlayOpacity = this.presentation().overlayOpacity;
    const o = clamp01(typeof overlayOpacity === 'number' ? overlayOpacity : 0.4);
    const fallback = '#0f172a';
    const hex = /^#?[0-9a-f]{3,8}$/i.test(this.presentation().overlayColor?.trim() ?? '')
      ? normalizeHex(this.presentation().overlayColor!.trim())
      : fallback;
    const { r, g, b } = hexRgb(hex);
    return { backgroundColor: `rgb(${r} ${g} ${b} / ${o})` };
  });

  protected readonly paddedBlockStyle = computed(() => ({
    padding: `${this.presentation().innerPaddingPx ?? 24}px`,
    textAlign: this.presentation().contentAlign ?? 'left',
    ...(this.maxWidthStyle() ?? {})
  }));

  protected readonly typographyVars = computed(
    (): Record<string, string> => ({
      position: 'relative',
      color: '#f9fafb',
      textShadow: '0 1px 22px rgba(0,0,0,0.55)'
    })
  );

  protected readonly blurStyle = computed(() => {
    const px = Number(this.presentation().overlayBlurPx ?? 0);
    const safe = Number.isFinite(px) ? Math.max(0, Math.min(24, px)) : 0;
    return safe > 0 ? { backdropFilter: `blur(${safe}px)` } : {};
  });

  private maxWidthStyle(): Record<string, string> | null {
    const m = this.presentation().textMaxWidthPx;
    if (m === undefined) return null;
    return { maxWidth: typeof m === 'number' ? `${m}px` : `${m}` };
  }
}

function clamp01(o: number) {
  return Math.max(0, Math.min(1, o));
}

function normalizeHex(raw: string) {
  const h = raw.startsWith('#') ? raw.slice(1) : raw;
  if (h.length === 3) return `#${h.split('').map((c) => c + c).join('')}`;
  return `#${h}`;
}

function hexRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  if (/^[0-9a-f]{3}$/i.test(h)) {
    const rx = `${h[0]}${h[0]}`;
    const gx = `${h[1]}${h[1]}`;
    const bx = `${h[2]}${h[2]}`;
    return {
      r: Number.parseInt(rx, 16),
      g: Number.parseInt(gx, 16),
      b: Number.parseInt(bx, 16)
    };
  }
  if (/^[0-9a-f]{6}$/i.test(h)) {
    return {
      r: Number.parseInt(h.slice(0, 2), 16),
      g: Number.parseInt(h.slice(2, 4), 16),
      b: Number.parseInt(h.slice(4, 6), 16)
    };
  }
  return { r: 15, g: 23, b: 42 };
}
