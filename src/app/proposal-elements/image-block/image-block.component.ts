import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  input,
  output,
  signal
} from '@angular/core';

import type { ProposalImageContent, ProposalImageStyle } from '../models/proposal-element.model';
import { ProposalImageCropDialogComponent } from '../proposal-image-crop-dialog.component';

export type ProposalImagePatch = Partial<ProposalImageContent>;

@Component({
  selector: 'proposal-image-block',
  standalone: true,
  imports: [CommonModule, ProposalImageCropDialogComponent],
  templateUrl: './image-block.component.html',
  styleUrl: './image-block.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ImageBlockComponent {
  readonly content = input.required<ProposalImageContent>();
  readonly presentation = input.required<ProposalImageStyle>();
  readonly editable = input(false);

  readonly imagePatch = output<ProposalImagePatch>();

  @ViewChild('fileInput') protected readonly fileInput?: ElementRef<HTMLInputElement>;

  protected readonly cropBlobUrl = signal<string | null>(null);
  private readonly pendingPickName = signal<string | null>(null);

  protected readonly activeTab = computed<'link' | 'upload'>(() => {
    const m = this.content().imageSourceMode;
    if (m === 'link' || m === 'upload') return m;
    return (this.content().src ?? '').trim().startsWith('blob:') ? 'upload' : 'link';
  });

  protected setTab(tab: 'link' | 'upload') {
    const c = this.content();
    const u = (c.src ?? '').trim();

    if (tab === 'upload') {
      if (!u.startsWith('blob:') && !c.uploadedFileName) {
        this.revokeCropState();
        this.imagePatch.emit({
          imageSourceMode: 'upload',
          src: undefined,
          uploadedFileName: undefined,
          uploadMimeType: undefined
        });
      } else {
        this.imagePatch.emit({
          imageSourceMode: 'upload',
          src: c.src,
          uploadedFileName: c.uploadedFileName,
          uploadMimeType: c.uploadMimeType
        });
      }
      return;
    }

    if (u.startsWith('blob:')) {
      this.revokeCropState();
      this.imagePatch.emit({
        imageSourceMode: 'link',
        src: '',
        uploadedFileName: undefined,
        uploadMimeType: undefined
      });
      return;
    }

    this.imagePatch.emit({
      imageSourceMode: 'link',
      src: c.src,
      uploadedFileName: undefined,
      uploadMimeType: undefined
    });
  }

  protected linkValue(): string {
    const s = (this.content().src ?? '').trim();
    if (s.startsWith('blob:') || s.startsWith('data:')) return '';
    return s;
  }

  protected onLinkInput(ev: Event) {
    const v = (ev.target as HTMLInputElement).value.trim();
    this.imagePatch.emit({
      imageSourceMode: 'link',
      src: v,
      uploadedFileName: undefined,
      uploadMimeType: undefined
    });
  }

  protected openFilePicker(ev: Event) {
    ev.preventDefault();
    this.fileInput?.nativeElement.click();
  }

  protected onFilePicked(ev: Event) {
    const inp = ev.target as HTMLInputElement;
    const f = inp.files?.[0];
    inp.value = '';
    if (!f || !f.type.startsWith('image/')) return;

    this.revokeCropState();
    this.pendingPickName.set(f.name);
    this.cropBlobUrl.set(URL.createObjectURL(f));
  }

  protected onCropConfirmed(out: { dataUrl: string; mime: string }) {
    const prev = this.cropBlobUrl();
    if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
    this.cropBlobUrl.set(null);

    const name = this.pendingPickName() ?? 'image.jpg';
    this.pendingPickName.set(null);

    this.imagePatch.emit({
      imageSourceMode: 'upload',
      src: out.dataUrl,
      uploadedFileName: name,
      uploadMimeType: out.mime
    });
  }

  protected onCropDismissed() {
    const prev = this.cropBlobUrl();
    if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
    this.cropBlobUrl.set(null);
    this.pendingPickName.set(null);
  }

  protected clearUploadSlot(ev: Event) {
    ev.preventDefault();
    this.revokeCropState();
    this.imagePatch.emit({
      imageSourceMode: 'upload',
      src: '',
      uploadedFileName: undefined,
      uploadMimeType: undefined
    });
  }

  protected clearLink(ev: Event) {
    ev.preventDefault();
    this.imagePatch.emit({
      imageSourceMode: 'link',
      src: '',
      uploadedFileName: undefined,
      uploadMimeType: undefined
    });
  }

  /** Revoke staged blob + clear names (not persisted model). */
  private revokeCropState() {
    const prev = this.cropBlobUrl();
    if (prev?.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(prev);
      } catch {
        /* noop */
      }
    }
    this.cropBlobUrl.set(null);
    this.pendingPickName.set(null);
  }
}
