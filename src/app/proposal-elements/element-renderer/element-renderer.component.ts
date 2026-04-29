import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { BackgroundImageTextBlockComponent } from '../background-image-text-block/background-image-text-block.component';
import type {
  ProposalBackgroundImageTextElementModel,
  ProposalImageElementModel,
  ProposalSlideElement,
  ProposalTextElementModel,
  ProposalTextOverlayImageElementModel,
  ProposalVideoElementModel,
  ProposalTextStyle
} from '../models/proposal-element.model';
import { ImageBlockComponent, type ProposalImagePatch } from '../image-block/image-block.component';
import { TextOverlayImageBlockComponent } from '../text-overlay-image-block/text-overlay-image-block.component';
import { TextBlockComponent } from '../text-block/text-block.component';
import { VideoBlockComponent, type ProposalVideoPatch } from '../video-block/video-block.component';

@Component({
  selector: 'proposal-element-renderer',
  standalone: true,
  imports: [
    CommonModule,
    TextBlockComponent,
    VideoBlockComponent,
    ImageBlockComponent,
    TextOverlayImageBlockComponent,
    BackgroundImageTextBlockComponent
  ],
  templateUrl: './element-renderer.component.html',
  styleUrl: './element-renderer.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ElementRendererComponent {
  readonly element = input.required<ProposalSlideElement>();

  /** When true nested text blocks expose inline tooling (proposal editor inspector). */
  readonly editable = input(false);

  readonly textHtmlPatch = output<{ elementId: string; html: string }>();
  readonly videoPatch = output<{ elementId: string; patch: ProposalVideoPatch }>();
  readonly imagePatch = output<{ elementId: string; patch: ProposalImagePatch }>();
  readonly overlayHtmlPatch = output<{ elementId: string; html: string }>();

  protected readonly textTypographyCss = computed(() => {
    const el = this.element();
    return el.type === 'text' ? typographyCssFromStyle(el.style) : {};
  });

  readonly eText = computed(
    (): ProposalTextElementModel => this.element() as ProposalTextElementModel
  );

  readonly eVideo = computed(
    (): ProposalVideoElementModel => this.element() as ProposalVideoElementModel
  );

  readonly eImage = computed(
    (): ProposalImageElementModel => this.element() as ProposalImageElementModel
  );

  readonly eTextOverlayImg = computed(
    (): ProposalTextOverlayImageElementModel =>
      this.element() as ProposalTextOverlayImageElementModel
  );

  readonly eBgImgTxt = computed(
    (): ProposalBackgroundImageTextElementModel =>
      this.element() as ProposalBackgroundImageTextElementModel
  );

  protected textHtml(ev: string) {
    const id = this.element().id;
    this.textHtmlPatch.emit({ elementId: id, html: ev });
  }

  protected mergeVideo(patch: ProposalVideoPatch) {
    const id = this.element().id;
    this.videoPatch.emit({ elementId: id, patch });
  }

  protected mergeImage(patch: ProposalImagePatch) {
    const id = this.element().id;
    this.imagePatch.emit({ elementId: id, patch });
  }

  protected overlayHtml(ev: string) {
    const id = this.element().id;
    this.overlayHtmlPatch.emit({ elementId: id, html: ev });
  }
}

export function typographyCssFromStyle(style: ProposalTextStyle): Record<string, string> {
  const out: Record<string, string> = {};
  if (style.fontFamily) out['font-family'] = style.fontFamily;
  if (style.fontSizePx) out['font-size'] = `${style.fontSizePx}px`;
  if (style.color) out['color'] = style.color;
  if (style.letterSpacingPx !== undefined) out['letter-spacing'] = `${style.letterSpacingPx}px`;
  if (style.lineHeight !== undefined) out['line-height'] = String(style.lineHeight);
  const pad = style.paddingPx;
  out['padding'] = pad !== undefined ? `${pad}px` : '6px';
  return out;
}
