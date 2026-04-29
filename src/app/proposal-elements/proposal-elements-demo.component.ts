import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { ProposalSlide, ProposalSlideElement } from './models/proposal-element.model';

import type { ProposalImagePatch } from './image-block/image-block.component';
import type { ProposalVideoPatch } from './video-block/video-block.component';
import { createSampleProposalSlide } from './proposal-sample-data';
import { ProposalSlideStageComponent } from './proposal-slide-stage/proposal-slide-stage.component';

@Component({
  selector: 'app-proposal-elements-demo',
  standalone: true,
  imports: [CommonModule, FormsModule, ProposalSlideStageComponent],
  templateUrl: './proposal-elements-demo.component.html',
  styleUrl: './proposal-elements-demo.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProposalElementsDemoComponent {
  protected readonly slide = signal<ProposalSlide>(createSampleProposalSlide());
  protected readonly selectedId = signal<string | null>(null);

  protected readonly selected = computed(() => {
    const id = this.selectedId();
    return id ? this.slide().elements.find((e) => e.id === id) ?? null : null;
  });

  protected readonly jsonPreview = computed(() => JSON.stringify(this.slide(), null, 2));

  protected select(id: string | null) {
    this.selectedId.set(id);
  }

  protected patchPosition(ev: { id: string; position: ProposalSlideElement['position'] }) {
    this.slide.update((s) => ({
      ...s,
      elements: s.elements.map((e) => (e.id === ev.id ? { ...e, position: ev.position } : e))
    }));
  }

  protected onTextHtml(ev: { elementId: string; html: string }) {
    this.slide.update((s) => ({
      ...s,
      elements: s.elements.map((e) =>
        e.id === ev.elementId && e.type === 'text' ? { ...e, content: { ...e.content, html: ev.html } } : e
      )
    }));
  }

  protected onImagePatch(ev: { elementId: string; patch: ProposalImagePatch }) {
    this.slide.update((s) => ({
      ...s,
      elements: s.elements.map((e) => {
        if (e.id !== ev.elementId || e.type !== 'image') return e;

        const prevSrc = `${e.content.src ?? ''}`.trim();
        const merged = { ...e.content, ...ev.patch };
        const nextSrc = `${merged.src ?? ''}`.trim();

        if (prevSrc.startsWith('blob:') && nextSrc !== prevSrc) {
          try {
            URL.revokeObjectURL(prevSrc);
          } catch {
            /* no-op */
          }
        }

        return { ...e, content: merged };
      })
    }));
  }

  protected onVideoPatch(ev: { elementId: string; patch: ProposalVideoPatch }) {
    this.slide.update((s) => ({
      ...s,
      elements: s.elements.map((e) => {
        if (e.id !== ev.elementId || e.type !== 'video') return e;

        const prevUrl = `${e.content.embedUrl || e.content.sourceUrl || ''}`.trim();
        const merged = { ...e.content, ...ev.patch };
        const nextUrl = `${merged.embedUrl || merged.sourceUrl || ''}`.trim();

        if (prevUrl.startsWith('blob:') && nextUrl !== prevUrl) {
          try {
            URL.revokeObjectURL(prevUrl);
          } catch {
            /* no-op */
          }
        }

        return { ...e, content: merged };
      })
    }));
  }

  protected onOverlay(ev: { elementId: string; html: string }) {
    this.slide.update((s) => ({
      ...s,
      elements: s.elements.map((e) => {
        if (e.id !== ev.elementId) return e;
        if (e.type === 'textOverlayImage') {
          return { ...e, content: { ...e.content, overlayHtml: ev.html } };
        }
        if (e.type === 'backgroundImageText') {
          return { ...e, content: { ...e.content, overlayHtml: ev.html } };
        }
        return e;
      })
    }));
  }

  protected bumpZ(delta: number) {
    const id = this.selectedId();
    if (!id) return;
    this.slide.update((s) => ({
      ...s,
      elements: s.elements.map((e) =>
        e.id === id
          ? { ...e, position: { ...e.position, zIndex: Math.max(0, e.position.zIndex + delta) } }
          : e
      )
    }));
  }
}
