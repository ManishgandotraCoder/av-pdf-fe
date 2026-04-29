import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { ElementRendererComponent } from '../element-renderer/element-renderer.component';
import {
  sortedByZ,
  type ProposalSlide,
  type ProposalSlideElement
} from '../models/proposal-element.model';
import { ProposalElementShellComponent } from '../proposal-element-shell/proposal-element-shell.component';
import type { ProposalImagePatch } from '../image-block/image-block.component';
import type { ProposalVideoPatch } from '../video-block/video-block.component';

@Component({
  selector: 'proposal-slide-stage',
  standalone: true,
  imports: [CommonModule, ProposalElementShellComponent, ElementRendererComponent],
  templateUrl: './proposal-slide-stage.component.html',
  styleUrl: './proposal-slide-stage.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProposalSlideStageComponent {
  readonly slide = input.required<ProposalSlide>();

  readonly selectedElementId = input<string | null>(null);

  readonly frameWidthPx = input(920);
  readonly frameHeightPx = input(520);

  readonly inspectorEditable = input(false);

  readonly selectElementId = output<string>();
  readonly patchElementPositionOnly = output<{
    id: string;
    position: ProposalSlideElement['position'];
  }>();
  readonly textHtmlPatch = output<{ elementId: string; html: string }>();
  readonly videoPatch = output<{ elementId: string; patch: ProposalVideoPatch }>();
  readonly imagePatch = output<{ elementId: string; patch: ProposalImagePatch }>();

  readonly overlayHtmlPatch = output<{ elementId: string; html: string }>();

  protected readonly layered = computed(() => sortedByZ(this.slide().elements ?? []));

  protected label(kind: ProposalSlideElement['type']): string {
    switch (kind) {
      case 'text':
        return 'Text';
      case 'video':
        return 'Video';
      case 'image':
        return 'Image';
      case 'textOverlayImage':
      case 'textOverImage':
        return 'Text · Image overlay';
      case 'backgroundImageText':
      case 'imageBackgroundText':
        return 'Bg image + text';
      default:
        return 'Element';
    }
  }

  protected onPatchPos(id: string, pos: ProposalSlideElement['position']) {
    this.patchElementPositionOnly.emit({ id, position: pos });
  }
}
