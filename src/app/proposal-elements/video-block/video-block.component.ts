import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  input,
  output
} from '@angular/core';

import type { ProposalVideoContent, ProposalVideoStyle } from '../models/proposal-element.model';
import { SafeVideoUrlPipe } from '../pipes/safe-resource-url.pipe';
import { parseVideoEmbedInput } from '../utils/video-embed';

/** Partial merge for `ProposalVideoContent` when the user picks link vs upload. */
export type ProposalVideoPatch = Partial<ProposalVideoContent>;

@Component({
  selector: 'proposal-video-block',
  standalone: true,
  imports: [CommonModule, SafeVideoUrlPipe],
  templateUrl: './video-block.component.html',
  styleUrl: './video-block.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class VideoBlockComponent {
  readonly content = input.required<ProposalVideoContent>();
  readonly presentation = input.required<ProposalVideoStyle>();
  readonly editable = input(false);

  readonly playerChange = output<ProposalVideoPatch>();

  @ViewChild('fileInput') protected readonly fileInput?: ElementRef<HTMLInputElement>;

  protected readonly parsed = computed(() => {
    const raw = this.playableUrlRaw().trim();
    return raw ? parseVideoEmbedInput(raw) : null;
  });

  protected playableUrlRaw = computed(() =>
    (this.content().embedUrl || this.content().sourceUrl || '').trim()
  );

  /** Tab reflects saved mode, or blob URLs imply upload. */
  protected readonly activeSource = computed<'embed' | 'upload'>(() => {
    const m = this.content().videoSourceMode;
    if (m === 'embed' || m === 'upload') return m;
    return this.playableUrlRaw().startsWith('blob:') ? 'upload' : 'embed';
  });

  protected readonly iframeTitle = computed(() => {
    const k = this.parsed()?.kind;
    if (k === 'youtube') return 'YouTube embed';
    if (k === 'vimeo') return 'Vimeo embed';
    return 'Embedded video';
  });

  protected onLinkInput(ev: Event) {
    const v = (ev.target as HTMLInputElement).value.trim();
    this.playerChange.emit({
      videoSourceMode: 'embed',
      embedUrl: v,
      sourceUrl: v,
      uploadedFileName: undefined,
      uploadMimeType: undefined
    });
  }

  protected setTab(mode: 'embed' | 'upload') {
    const u = this.playableUrlRaw();

    if (mode === 'upload') {
      if (!u.startsWith('blob:')) {
        /** Switch from a pasted link to local upload — clear remote URL until a file is chosen. */
        this.playerChange.emit({
          videoSourceMode: 'upload',
          embedUrl: undefined,
          sourceUrl: '',
          uploadedFileName: undefined,
          uploadMimeType: undefined
        });
      } else {
        this.playerChange.emit({
          videoSourceMode: 'upload',
          embedUrl: this.content().embedUrl,
          sourceUrl: this.content().sourceUrl,
          uploadedFileName: this.content().uploadedFileName,
          uploadMimeType: this.content().uploadMimeType
        });
      }
      return;
    }

    /** embed tab — dropped blob uploads cannot be edited as plain text URLs */
    if (u.startsWith('blob:')) {
      this.playerChange.emit({
        videoSourceMode: 'embed',
        embedUrl: undefined,
        sourceUrl: '',
        uploadedFileName: undefined,
        uploadMimeType: undefined
      });
      return;
    }

    this.playerChange.emit({
      videoSourceMode: 'embed',
      embedUrl: this.content().embedUrl,
      sourceUrl: this.content().sourceUrl,
      uploadedFileName: undefined,
      uploadMimeType: undefined
    });
  }

  protected openFilePicker(ev: Event) {
    ev.preventDefault();
    this.fileInput?.nativeElement.click();
  }

  protected onFileSelected(ev: Event) {
    const inputEl = ev.target as HTMLInputElement;
    const file = inputEl.files?.[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    this.playerChange.emit({
      videoSourceMode: 'upload',
      embedUrl: url,
      sourceUrl: url,
      uploadedFileName: file.name,
      uploadMimeType: file.type || undefined
    });

    inputEl.value = '';
  }

  protected clearUploaded(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    this.playerChange.emit({
      videoSourceMode: 'upload',
      embedUrl: undefined,
      sourceUrl: '',
      uploadedFileName: undefined,
      uploadMimeType: undefined
    });
  }

  protected toggleFlag(key: 'autoplay' | 'muted' | 'loop', checked: boolean) {
    this.playerChange.emit({ [key]: checked });
  }

  protected onPosterInput(ev: Event) {
    this.playerChange.emit({ posterImage: (ev.target as HTMLInputElement).value.trim() });
  }

  /** Link field skips blob URLs (shown in upload panel instead). */
  protected linkInputValue(): string {
    const u = this.playableUrlRaw();
    if (u.startsWith('blob:')) return '';
    return u;
  }
}
