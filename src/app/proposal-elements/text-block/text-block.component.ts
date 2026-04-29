import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  effect,
  input,
  output
} from '@angular/core';

import type { ProposalTextRichContent } from '../models/proposal-element.model';

/**
 * Proposal-only rich text block — does not interact with legacy PDF canvas text widgets.
 */
@Component({
  selector: 'proposal-text-block',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './text-block.component.html',
  styleUrl: './text-block.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TextBlockComponent {
  readonly content = input.required<ProposalTextRichContent>();
  readonly editable = input(false);
  /** Merged CSS var map for typography (font/size/color spacing). */
  readonly typographyCssVars = input<Record<string, string>>({});

  readonly htmlChange = output<string>();

  @ViewChild('editor') private readonly editor?: ElementRef<HTMLDivElement>;

  constructor() {
    effect((onCleanup) => {
      if (!this.editable()) return;

      const t = window.setTimeout(() => {
        const el = this.editor?.nativeElement;
        if (!el) return;
        const next = this.content().html;
        if (document.activeElement !== el && el.innerHTML !== next)
          el.innerHTML = next && next.trim().length > 0 ? next : '<p>&#8203;</p>';
      }, 0);
      onCleanup(() => window.clearTimeout(t));
    });
  }

  protected onEditableInput(html: string) {
    this.htmlChange.emit(html);
  }

  protected cmd(command: string, value?: string) {
    const el = this.editor?.nativeElement;
    el?.focus();
    document.execCommand(command, false, value ?? undefined);
    const next = el?.innerHTML ?? '';
    this.onEditableInput(next);
  }

  protected applyAlignment(align: 'left' | 'center' | 'right' | 'justify') {
    const map: Record<string, string> = {
      left: 'justifyLeft',
      center: 'justifyCenter',
      right: 'justifyRight',
      justify: 'justifyFull'
    };
    this.cmd(map[align]!);
  }

  protected blockTag(tag: 'p' | 'h2') {
    this.cmd('formatBlock', `<${tag}>`);
  }

  protected onPaste(ev: ClipboardEvent) {
    ev.preventDefault();
    const t = ev.clipboardData?.getData('text/plain') ?? '';
    document.execCommand('insertText', false, t);
    const el = this.editor?.nativeElement;
    if (el) this.onEditableInput(el.innerHTML);
  }
}
