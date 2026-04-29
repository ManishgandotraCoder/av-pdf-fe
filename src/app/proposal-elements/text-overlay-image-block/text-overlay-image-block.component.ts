import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type {
  ProposalTextOverlayImageContent,
  ProposalTextOverlayImageStyle,
  ProposalTextRichContent
} from '../models/proposal-element.model';
import { TextBlockComponent } from '../text-block/text-block.component';

@Component({
  selector: 'proposal-text-overlay-image-block',
  standalone: true,
  imports: [CommonModule, TextBlockComponent],
  templateUrl: './text-overlay-image-block.component.html',
  styleUrl: './text-overlay-image-block.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TextOverlayImageBlockComponent {
  readonly content = input.required<ProposalTextOverlayImageContent>();
  readonly presentation = input.required<ProposalTextOverlayImageStyle>();
  /** Text edit mode propagated to overlay TextBlock. */
  readonly textEditable = input(false);

  readonly overlayPatch = output<string>();

  protected readonly overlayRich = computed<ProposalTextRichContent>(() => ({
    html: this.content().overlayHtml ?? '<p>&#8203;</p>'
  }));

  protected readonly typographyVars = computed(() =>
    this.maskTone() === 'light'
      ? {
          color: '#18181b',
          textShadow: '0 1px 0 rgba(255,255,255,0.42)'
        }
      : ({ color: '#ffffff', textShadow: '0 2px 10px rgba(0,0,0,0.32)' } as Record<string, string>)
  );

  /** Custom preset → translate layer into quadrant from center-ish anchor. */
  protected readonly overlayTransform = computed(() => {
    const pos = this.content().overlayPosition;
    if ((pos?.preset ?? 'center') !== 'custom') return 'none';
    const ax = pos?.anchorX ?? 0.5;
    const ay = pos?.anchorY ?? 0.5;
    const ox = `${(ax - 0.5) * 140}%`; // widen spread subtly
    const oy = `${(ay - 0.5) * 140}%`;
    return `translate(${ox}, ${oy})`;
  });

  protected readonly maskTone = computed(() => this.presentation().overlayMaskTone ?? 'dark');

  protected readonly overlayGradient = computed(() => {
    const fallback = this.maskTone() === 'none' ? 0 : 0.45;
    const raw = this.presentation().overlayMaskOpacity;
    const op = Math.max(
      0,
      Math.min(1, typeof raw === 'number' ? raw : fallback)
    );
    if (this.maskTone() === 'light')
      return `linear-gradient(rgba(255,255,255,${op}), rgba(255,255,255,${op}))`;
    if (this.maskTone() === 'none') return 'transparent';
    return `linear-gradient(rgba(0,0,0,${op}), rgba(0,0,0,${op}))`;
  });

  /** Avoid inline template parse issues with chained ternaries. */
  protected readonly fallbackPad = computed(() =>
    `${this.presentation().contentPaddingPx ?? 14}px`);

  /** Map text overlay alignment onto flex items (inner text block aligns full width). */
  protected readonly textAlign = computed(() => this.presentation().textAlign ?? 'center');

  /** Extra transform when custom XY — inner flex column */
  protected readonly presetClass = computed(() => {
    const p = this.content().overlayPosition?.preset ?? 'center';
    return `preset--${p}`;
  });
}
