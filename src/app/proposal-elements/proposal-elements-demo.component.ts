import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { ProposalSlide, ProposalSlideElement } from './models/proposal-element.model';

import type { ProposalImagePatch } from './image-block/image-block.component';
import type { ProposalVideoPatch } from './video-block/video-block.component';
import { ProposalElementsApiService } from './proposal-elements-api.service';
import { createSampleProposalSlide } from './proposal-sample-data';
import { ProposalSlideStageComponent } from './proposal-slide-stage/proposal-slide-stage.component';
import { newProposalLocalId } from './models/proposal-element.model';

@Component({
  selector: 'app-proposal-elements-demo',
  standalone: true,
  imports: [CommonModule, FormsModule, ProposalSlideStageComponent],
  templateUrl: './proposal-elements-demo.component.html',
  styleUrl: './proposal-elements-demo.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProposalElementsDemoComponent {
  private readonly api = inject(ProposalElementsApiService);
  protected readonly slide = signal<ProposalSlide>(createSampleProposalSlide());
  protected readonly selectedId = signal<string | null>(null);
  protected readonly status = signal('');

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
    void this.persistPatch(ev.id, { position: ev.position });
  }

  protected onTextHtml(ev: { elementId: string; html: string }) {
    this.slide.update((s) => ({
      ...s,
      elements: s.elements.map((e) =>
        e.id === ev.elementId && e.type === 'text' ? { ...e, content: { ...e.content, html: ev.html } } : e
      )
    }));
    void this.persistPatch(ev.elementId, { content: { html: ev.html } } as Partial<ProposalSlideElement>);
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

        return { ...e, content: merged, style: { ...e.style, ...(ev.patch.style ?? {}) } };
      })
    }));
    void this.persistPatch(ev.elementId, {
      content: ev.patch,
      style: ev.patch.style
    } as Partial<ProposalSlideElement>);
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
    void this.persistPatch(ev.elementId, { content: ev.patch } as Partial<ProposalSlideElement>);
  }

  protected onOverlay(ev: { elementId: string; html: string }) {
    this.slide.update((s) => ({
      ...s,
      elements: s.elements.map((e) => {
        if (e.id !== ev.elementId) return e;
        if (e.type === 'textOverlayImage' || e.type === 'textOverImage') {
          return { ...e, content: { ...e.content, overlayHtml: ev.html } };
        }
        if (e.type === 'backgroundImageText' || e.type === 'imageBackgroundText') {
          return { ...e, content: { ...e.content, overlayHtml: ev.html } };
        }
        return e;
      })
    }));
    void this.persistPatch(ev.elementId, { content: { overlayHtml: ev.html } } as Partial<ProposalSlideElement>);
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
    const sel = this.selected();
    if (id && sel) void this.persistPatch(id, { position: sel.position } as Partial<ProposalSlideElement>);
  }

  protected async addElement(kind: ProposalSlideElement['type']) {
    const base: ProposalSlideElement = {
      id: newProposalLocalId(kind),
      type: kind,
      content: {},
      style: {},
      position: { x: 48, y: 48, width: 280, height: 160, zIndex: this.slide().elements.length + 1, rotation: 0 }
    } as ProposalSlideElement;

    const seeded = seedElement(base);
    this.slide.update((s) => ({ ...s, elements: [...s.elements, seeded] }));
    this.selectedId.set(seeded.id);
    try {
      const updated = await this.api.addElement(this.slide().id, seeded);
      this.slide.set(updated);
      this.status.set('Element added');
    } catch {
      this.status.set('Saved locally (API unavailable)');
    }
  }

  protected async removeSelected() {
    const id = this.selectedId();
    if (!id) return;
    this.slide.update((s) => ({ ...s, elements: s.elements.filter((e) => e.id !== id) }));
    this.selectedId.set(null);
    try {
      const updated = await this.api.deleteElement(id);
      this.slide.set(updated);
      this.status.set('Element deleted');
    } catch {
      this.status.set('Deleted locally (API unavailable)');
    }
  }

  private async persistPatch(elementId: string, patch: Partial<ProposalSlideElement>) {
    try {
      const updated = await this.api.patchElement(elementId, patch);
      this.slide.set(updated);
    } catch {
      // non-fatal in demo mode
    }
  }
}

function seedElement(el: ProposalSlideElement): ProposalSlideElement {
  if (el.type === 'text') {
    return {
      ...el,
      content: { html: '<p>New text</p>' },
      style: { fontSizePx: 18, color: '#0f172a', align: 'left', paddingPx: 10 }
    } as ProposalSlideElement;
  }
  if (el.type === 'video') {
    return { ...el, content: { autoplay: false, muted: true, loop: false }, style: { objectFit: 'contain' } } as ProposalSlideElement;
  }
  if (el.type === 'image') {
    return { ...el, style: { objectFit: 'cover', borderRadiusPx: 8 } } as ProposalSlideElement;
  }
  if (el.type === 'textOverImage' || el.type === 'textOverlayImage') {
    return {
      ...el,
      type: 'textOverImage',
      content: { overlayHtml: '<p>Overlay text</p>', overlayPosition: { preset: 'center' } },
      style: { overlayMaskOpacity: 0.45, overlayMaskTone: 'dark', textAlign: 'center' }
    } as ProposalSlideElement;
  }
  return {
    ...el,
    type: 'imageBackgroundText',
    content: { overlayHtml: '<h3>Hero section</h3><p>Banner copy</p>' },
    style: { backgroundSize: 'cover', overlayOpacity: 0.45, innerPaddingPx: 24, contentAlign: 'left' }
  } as ProposalSlideElement;
}
