import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  QueryList,
  ViewChild,
  ViewChildren,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ActivatedRoute, Router } from '@angular/router';
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { PdfApiService } from '../pdf-api/pdf-api.service';
import { AssetMetaService } from '../asset-meta/asset-meta.service';

type Tool = 'pan' | 'pen' | 'text' | 'image';
type FontStyle = 'regular' | 'bold' | 'italic' | 'boldItalic';
type FontFamily =
  | 'helvetica'
  | 'times'
  | 'courier'
  | 'poppins'
  | 'montserrat'
  | 'abcdee_helvetica_bold';

type WidgetKind = 'table' | 'image' | 'text' | 'video' | 'signature';
type Widget = {
  id: string;
  kind: WidgetKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** PNG/JPEG data URL for image widgets */
  imageSrc?: string;
  /** Object URL for video widgets (revoked on remove) */
  videoSrc?: string;
  /** Plain text for text widgets */
  textValue?: string;
  /** Signature image data URL */
  signatureSrc?: string;
  /** Basic editable table model */
  table?: { rows: number; cols: number; cells: string[][] };
};

type InsertWidgetPending = {
  kind: WidgetKind;
  imageDataUrl?: string;
  videoObjectUrl?: string;
};

type ToolbarIcon =
  | 'undo'
  | 'redo'
  | 'print'
  | 'spellcheck'
  | 'template'
  | 'zoomOut'
  | 'zoomIn'
  | 'bold'
  | 'italic'
  | 'textColor'
  | 'bgColor'
  | 'image'
  | 'pen'
  | 'text'
  | 'pan';

type ToolbarItem =
  | { kind: 'sep'; id: string }
  | {
      kind: 'button';
      id: string;
      title: string;
      icon: ToolbarIcon;
      onClick: () => void;
      disabled?: () => boolean;
      active?: () => boolean;
    }
  | {
      kind: 'select';
      id: string;
      title: string;
      value: () => any;
      setValue: (v: any) => void;
      options: { label: string; value: any }[];
      disabled?: () => boolean;
    }
  | {
      kind: 'color';
      id: string;
      title: string;
      value: () => string;
      setValue: (v: string) => void;
      disabled?: () => boolean;
    }
  | {
      kind: 'file';
      id: string;
      title: string;
      icon: ToolbarIcon;
      accept: string;
      onChange: (ev: Event) => void;
      disabled?: () => boolean;
    }
  | {
      kind: 'group';
      id: string;
      items: ToolbarItem[];
    };

type InkPoint = { x: number; y: number };
type InkStroke = { color: string; width: number; points: InkPoint[] };
type TextAnno = {
  color: string;
  fontSize: number;
  fontStyle: FontStyle;
  fontFamily: FontFamily;
  bgColor?: string | null;
  x: number;
  y: number;
  text: string;
};

type ImageAnno = {
  /** Stable id for selection / toolbars */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  dataUrl: string;
  /** Natural pixel size of `dataUrl` when placed (for crop) */
  srcW: number;
  srcH: number;
  /** Crop rect in full-image pixel coordinates (default: full image) */
  crop?: { x: number; y: number; w: number; h: number };
};

type PlacedImageEdge = 'n' | 's' | 'e' | 'w';
type WidgetResizeEdge = 'n' | 's' | 'e' | 'w' | 'br';
type ActivePlacedImageOp = {
  pageIndex: number;
  id: string;
  pointerId: number;
  mode: 'move' | 'resize';
  edge: PlacedImageEdge | null;
  startX: number;
  startY: number;
  orig: { x: number; y: number; w: number; h: number };
};

type DetectedText = {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize: number;
  fontStyle: FontStyle;
};

type DetectedBlockKind = 'paragraph' | 'list' | 'heading';
type DetectedBlock = {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize: number;
  fontStyle: FontStyle;
  kind: DetectedBlockKind;
};

type TextReplace = {
  x: number;
  y: number;
  w: number;
  h: number;
  oldText: string;
  newText: string;
  // For scanned/image PDFs, solid bg fills look wrong. We support:
  // - 'color': fill with sampled bgColor
  // - 'inpaint': copy/blend nearby pixels into the region (visual erase)
  maskMode: 'color' | 'inpaint';
  bgColor: string;
  color: string;
  fontSize: number;
  fontStyle: FontStyle;
  fontFamily: FontFamily;
};

type PageEdits = {
  viewportWidth: number;
  viewportHeight: number;
  ink: InkStroke[];
  text: TextAnno[];
  images: ImageAnno[];
  replaces: TextReplace[];
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const raw = hex.replace('#', '').trim();
  const normalized = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  const v = Number.parseInt(normalized, 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  return { r: r / 255, g: g / 255, b: b / 255 };
}

function inferFontStyleFromPdfJsStyle(raw: any): FontStyle {
  // pdf.js style objects vary wildly across PDFs.
  // The most reliable signals are usually encoded in the font name itself.
  const a = String(raw?.fontFamily ?? '').toLowerCase();
  const b = String(raw?.fontName ?? '').toLowerCase();
  const c = String(raw?.name ?? '').toLowerCase();
  const combined = `${a} ${b} ${c}`;

  const fontWeightRaw = raw?.fontWeight;
  const fontWeight = typeof fontWeightRaw === 'number' ? fontWeightRaw : Number(fontWeightRaw ?? 400);

  const isItalic =
    Boolean(raw?.italic) ||
    Boolean(raw?.oblique) ||
    /(^|[\s\-+,_])(italic|oblique)([\s\-+,_]|$)/.test(combined);

  // Common names: Bold, Black, Heavy, SemiBold/DemiBold.
  // Also handle abbreviations frequently found in embedded/subset fonts: Bd, B, SB, Demi, etc.
  // (We avoid matching "book" or "light" as bold.)
  const isBoldByName =
    /(^|[\s\-+,_])(bold|black|heavy|extrabold|ultrabold|semibold|demibold|demi)([\s\-+,_]|$)/.test(combined) ||
    /(^|[\s\-+,_])(bd|sb|xb|eb|ub)([\s\-+,_]|$)/.test(combined) ||
    /([\-+,_])(bd|b)([\s\-+,_]|$)/.test(combined);
  const isBoldByWeight = Number.isFinite(fontWeight) ? fontWeight >= 600 : false;
  const isBold = isBoldByName || isBoldByWeight;

  if (isBold && isItalic) return 'boldItalic';
  if (isBold) return 'bold';
  if (isItalic) return 'italic';
  return 'regular';
}

function dominantFontStyle(styles: FontStyle[]): FontStyle {
  if (styles.length === 0) return 'regular';
  // Choose a stable style for a block: use a simple score/majority so
  // a mostly-regular paragraph with a single bold word doesn't become "bold".
  const score = (s: FontStyle) => (s === 'boldItalic' ? 3 : s === 'bold' ? 2 : s === 'italic' ? 1 : 0);
  let sum = 0;
  let boldLike = 0;
  let italicLike = 0;
  for (const s of styles) {
    sum += score(s);
    if (s === 'bold' || s === 'boldItalic') boldLike++;
    if (s === 'italic' || s === 'boldItalic') italicLike++;
  }
  const n = styles.length;
  const avg = sum / n;

  // Thresholds tuned for stability:
  // - need at least half the spans to be bold-like to classify bold
  // - need at least half italic-like to classify italic
  const isBold = boldLike / n >= 0.5 || avg >= 1.6;
  const isItalic = italicLike / n >= 0.5 || avg >= 1.2;

  if (isBold && isItalic) return 'boldItalic';
  if (isBold) return 'bold';
  if (isItalic) return 'italic';
  return 'regular';
}

function cssFontFamily(f: FontFamily): string {
  if (f === 'abcdee_helvetica_bold') return '"Helvetica Neue", Arial, sans-serif';
  if (f === 'poppins') return '"Poppins", "Helvetica Neue", Arial, sans-serif';
  if (f === 'montserrat') return '"Montserrat", "Poppins", "Helvetica Neue", Arial, sans-serif';
  if (f === 'times') return '"Times New Roman", Times, serif';
  if (f === 'courier') return '"Courier New", Courier, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
  return 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial';
}

function styleWithWeight(style: FontStyle, weight: 400 | 700): FontStyle {
  const italic = style === 'italic' || style === 'boldItalic';
  if (weight === 700) return italic ? 'boldItalic' : 'bold';
  return italic ? 'italic' : 'regular';
}

function weightFromStyle(style: FontStyle): 400 | 700 {
  return style === 'bold' || style === 'boldItalic' ? 700 : 400;
}

@Component({
  selector: 'app-pdf-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './pdf-editor.component.html',
  styleUrl: './pdf-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PdfEditorComponent implements AfterViewInit {
  private readonly destroyRef = inject(DestroyRef);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(PdfApiService);
  private readonly assetMeta = inject(AssetMetaService);

  protected readonly Math = Math;
  protected readonly range = (n: number) => Array.from({ length: Math.max(0, n) }, (_, i) => i);

  private renderAllPagesEpoch = 0;
  private readonly renderTaskByPage = new Map<number, any>();

  private readonly undoStack: Record<number, PageEdits>[] = [];
  private readonly redoStack: Record<number, PageEdits>[] = [];
  private readonly maxHistoryEntries = 200;

  @ViewChildren('pageCanvas') private readonly pageCanvases?: QueryList<
    ElementRef<HTMLCanvasElement>
  >;
  @ViewChildren('overlayCanvas') private readonly overlayCanvases?: QueryList<
    ElementRef<HTMLCanvasElement>
  >;
  @ViewChildren('pageHost') private readonly pageHosts?: QueryList<ElementRef<HTMLElement>>;

  protected readonly fileName = signal<string | null>(null);
  protected readonly tool = signal<Tool>('text');
  protected readonly penColor = signal('#ff2d55');
  protected readonly penWidth = signal(3);
  protected readonly textColor = signal('#22c55e');
  protected readonly textSize = signal(18);
  protected readonly textStyle = signal<FontStyle>('regular');
  protected readonly textFamily = signal<FontFamily>('helvetica');
  protected readonly textBgEnabled = signal(false);
  protected readonly textBgColor = signal('#ffffff');
  protected readonly editExistingText = signal(true);
  /** When false, embedded-text detection is skipped and PDF text/editing widgets are inactive. */
  protected readonly textFeatureEnabled = signal(true);
  // Default PDF display at 80%.
  protected readonly scale = signal(0.8);
  protected readonly sidebarCollapsed = signal(false);

  protected readonly openDocsMenu = signal<'Insert' | null>(null);

  protected readonly widgetsByPage = signal<Record<number, Widget[]>>({});
  protected readonly selectedWidgetId = signal<string | null>(null);

  @ViewChild('pdfImageFile') private readonly pdfImageFile?: ElementRef<HTMLInputElement>;
  @ViewChild('widgetImageFile') private readonly widgetImageFile?: ElementRef<HTMLInputElement>;
  @ViewChild('widgetVideoFile') private readonly widgetVideoFile?: ElementRef<HTMLInputElement>;
  @ViewChild('widgetSignatureFile') private readonly widgetSignatureFile?: ElementRef<HTMLInputElement>;

  /** Click insert flow: pick type (and file for image/video), then click the page to place. */
  protected readonly insertWidgetPending = signal<InsertWidgetPending | null>(null);
  protected readonly editingWidgetId = signal<string | null>(null);
  private signaturePickTargetWidgetId: string | null = null;

  private readonly videoObjectUrlByWidgetId = new Map<string, string>();

  private activeWidgetOp:
    | null
    | {
        pageIndex: number;
        id: string;
        pointerId: number;
        mode: 'move' | 'resize';
        /** Set when `mode === 'resize'`. */
        resizeEdge: WidgetResizeEdge | null;
        startX: number;
        startY: number;
        origX: number;
        origY: number;
        origW: number;
        origH: number;
      } = null;

  private activePlacedImageOp: ActivePlacedImageOp | null = null;
  private static readonly placedImageHandlePx = 7;
  private static readonly placedImageHandleHit = 10;

  protected readonly selectedPlacedImageId = signal<string | null>(null);
  protected readonly imageCropSession = signal<{
    pageIndex: number;
    id: string;
    leftPct: number;
    topPct: number;
    rightPct: number;
    bottomPct: number;
  } | null>(null);

  protected readonly isLoading = signal(false);
  protected readonly errorText = signal<string | null>(null);
  protected readonly isInserting = signal(false);
  protected readonly isPageRendering = signal(false);

  protected readonly docId = signal<string | null>(null);

  private pdfBytes: Uint8Array | null = null;
  private pdfDoc: PDFDocumentProxy | null = null;

  private clonePdfBytes(bytes: Uint8Array): Uint8Array {
    // Always copy. pdf.js can transfer/detach the underlying buffer when `data` is a TypedArray;
    // we must not reuse that same view for pdf-lib or keep it as our canonical `pdfBytes`.
    const out = new Uint8Array(bytes.byteLength);
    out.set(bytes);
    return out;
  }

  private assertReadablePdfHeader(bytes: Uint8Array) {
    if (bytes.byteLength < 5) {
      throw new Error('Empty PDF (no bytes).');
    }
    const head = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!);
    if (head !== '%PDF-') {
      throw new Error('Not a valid PDF (missing %PDF- header).');
    }
  }

  protected readonly pageCount = signal(0);
  protected readonly pages = computed(() => Array.from({ length: this.pageCount() }, (_, i) => i));
  protected readonly activePageIndex = signal(0);
  protected readonly openPageMenuIndex = signal<number | null>(null);
  protected readonly deleteSlideModalOpen = signal(false);
  protected readonly deleteSlideTargetIndex = signal<number | null>(null);
  /** Short-lived UX messages (toast) for slide management */
  protected readonly slideToast = signal<string | null>(null);
  private slideToastClearTimer: ReturnType<typeof setTimeout> | null = null;
  /** HTML5 sidebar slide reorder: drag source index (mirror of dataTransfer) */
  protected readonly slideDragFromIndex = signal<number | null>(null);
  /** Drop-zone highlight during slide drag */
  protected readonly slideDropHoverIndex = signal<number | null>(null);
  /** Which sidebar slide row has the actions menu open (remove / duplicate / add). */
  protected readonly sidebarSlideMenuOpenIndex = signal<number | null>(null);

  /** MIME type for native slide reorder (sidebar). */
  private static readonly slideDragMime = 'application/x-avyro-slide-from';
  protected readonly pageThumbUrlByPage = signal<Record<number, string>>({});
  private thumbsEpoch = 0;

  protected readonly editsByPage = signal<Record<number, PageEdits>>({});
  protected readonly detectedTextByPage = signal<Record<number, DetectedText[]>>({});
  protected readonly detectedBlocksByPage = signal<Record<number, DetectedBlock[]>>({});
  private readonly baseSnapshotByPage = new Map<number, ImageData>();
  private readonly pageRotateByPage = new Map<number, number>();

  private activeInk:
    | { pageIndex: number; stroke: InkStroke; pointerId: number; lastPoint?: InkPoint }
    | null = null;

  private editingReplace: { pageIndex: number; idx: number } | null = null;
  private suppressCommitOnBlurOnce = false;

  protected readonly isTextPlacing = signal(false);
  protected readonly textDraft = signal('');
  protected readonly textDraftPageIndex = signal<number | null>(null);
  protected readonly textDraftX = signal(0);
  protected readonly textDraftY = signal(0);
  private textDraftBox:
    | {
        w: number;
        h: number;
        oldText: string;
        bgColor: string;
        color: string;
        maskMode: 'color' | 'inpaint';
        fontSize: number;
        fontStyle: FontStyle;
        fontFamily: FontFamily;
      }
    | null = null;

  protected readonly isImagePlacing = signal(false);
  private pendingImageDataUrl: string | null = null;

  constructor() {
    // Emit via angular.json assets (see pdfjs-dist/build) so prod deploy serves a real file;
    // new URL(import.meta.url) resolves to /pdfjs-dist/... which is covered by SPA rewrites unless the file exists in dist.
    GlobalWorkerOptions.workerSrc = '/pdfjs-dist/build/pdf.worker.min.mjs';

    effect(() => {
      // Re-render pages when zoom changes.
      const _ = this.scale();
      void this.renderActivePage();
    });

    effect(() => {
      // Re-render when switching pages.
      const _ = this.activePageIndex();
      void this.renderActivePage();
    });

    // Load the selected PDF from the library (route param).
    effect(() => {
      const id = this.route.snapshot.paramMap.get('id');
      this.docId.set(id);
      if (id) void this.loadFromApi(id);
    });
  }

  protected readonly zoomOptions = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.25, 2.5] as const;
  protected readonly fontSizeOptions = [
    8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48, 56, 64, 72
  ] as const;
  protected readonly fontFamilyOptions: { label: string; value: FontFamily }[] = [
    { label: 'Helvetica', value: 'helvetica' },
    { label: 'Times', value: 'times' },
    { label: 'Courier', value: 'courier' },
    { label: 'Poppins', value: 'poppins' },
    { label: 'Montserrat', value: 'montserrat' },
    { label: 'Helvetica Bold (subset)', value: 'abcdee_helvetica_bold' }
  ];

  protected toggleItalic() {
    this.textStyle.set(this.textStyle() === 'italic' ? 'regular' : 'italic');
  }

  protected toggleBold() {
    this.setTextWeight(this.textWeight() === 700 ? 400 : 700);
  }

  protected toggleTextBgEnabled() {
    this.textBgEnabled.set(!this.textBgEnabled());
  }

  protected toggleTextFeatureEnabled() {
    const next = !this.textFeatureEnabled();
    this.textFeatureEnabled.set(next);

    if (!next) {
      this.cancelTextDraft();
      if (this.tool() === 'text') this.tool.set('pan');
      const ew = this.editingWidgetId();
      if (ew) {
        const w = this.getWidget(this.activePageIndex(), ew);
        if (w?.kind === 'text') this.stopEditingWidget(ew);
      }
      // Clear all pages so navigation cannot leave stale hit targets.
      this.detectedTextByPage.set({});
      this.detectedBlocksByPage.set({});
    }

    this.cdr.markForCheck();
    void this.renderActivePage().finally(() => this.cdr.markForCheck());
  }

  protected toggleSidebar() {
    this.sidebarCollapsed.set(!this.sidebarCollapsed());
  }

  protected toggleDocsMenu(menu: 'Insert', ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    this.openDocsMenu.set(this.openDocsMenu() === menu ? null : menu);
  }

  protected closeDocsMenu() {
    this.openDocsMenu.set(null);
  }

  protected onInsertFromMenu(kind: WidgetKind, ev: Event) {
    this.closeDocsMenu();
    this.onInsertWidgetClick(kind, ev);
  }

  protected pickPdfImageFromMenu(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    this.closeDocsMenu();
    const el = this.pdfImageFile?.nativeElement;
    if (!el) return;
    el.value = '';
    el.click();
  }

  protected onWidgetDragStart(kind: WidgetKind, ev: DragEvent) {
    try {
      const dt = ev.dataTransfer;
      if (!dt) return;
      dt.setData('application/x-avyro-widget-kind', kind);
      dt.setData('text/plain', kind);
      dt.effectAllowed = 'copy';
    } catch {
      // ignore
    }
  }

  private pendingPdfImageDrop: { pageIndex: number; x: number; y: number } | null = null;
  private pendingVideoWidgetDrop: { pageIndex: number; x: number; y: number } | null = null;

  protected onPdfImageDragStart(ev: DragEvent) {
    try {
      const dt = ev.dataTransfer;
      if (!dt) return;
      dt.setData('application/x-avyro-pdf-insert', 'image');
      dt.effectAllowed = 'copy';
    } catch {
      // ignore
    }
  }

  protected onPdfVideoDragStart(ev: DragEvent) {
    try {
      const dt = ev.dataTransfer;
      if (!dt) return;
      dt.setData('application/x-avyro-pdf-insert', 'video');
      dt.effectAllowed = 'copy';
    } catch {
      // ignore
    }
  }

  protected onInsertWidgetClick(kind: WidgetKind, ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();

    // Pan mode disables overlay pointer events; placement is click-driven.
    this.tool.set('text');

    if (kind === 'image') {
      this.insertWidgetPending.set(null);
      const el = this.widgetImageFile?.nativeElement;
      if (el) {
        el.value = '';
        el.click();
      }
      return;
    }

    if (kind === 'video') {
      this.insertWidgetPending.set(null);
      const el = this.widgetVideoFile?.nativeElement;
      if (el) {
        el.value = '';
        el.click();
      }
      return;
    }

    if (kind === 'signature') {
      this.insertWidgetPending.set(null);
      const el = this.widgetSignatureFile?.nativeElement;
      if (el) {
        el.value = '';
        el.click();
      }
      return;
    }

    this.insertWidgetPending.set({ kind });
  }

  protected onWidgetInsertImagePicked(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;

    this.errorText.set(null);
    this.isInserting.set(true);
    const reader = new FileReader();
    reader.onerror = () => {
      this.errorText.set('Failed to read image.');
      this.isInserting.set(false);
    };
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      if (!/^data:image\/(png|jpeg);base64,/i.test(dataUrl)) {
        this.errorText.set('Unsupported image (use PNG or JPEG).');
        this.isInserting.set(false);
        return;
      }
      this.tool.set('text');
      this.insertWidgetPending.set({ kind: 'image', imageDataUrl: dataUrl });
    };
    reader.readAsDataURL(file);
  }

  protected onWidgetInsertVideoPicked(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) {
      this.pendingVideoWidgetDrop = null;
      return;
    }

    this.errorText.set(null);
    try {
      const objectUrl = URL.createObjectURL(file);
      this.tool.set('text');
      if (this.pendingVideoWidgetDrop) {
        const { pageIndex, x, y } = this.pendingVideoWidgetDrop;
        this.pendingVideoWidgetDrop = null;
        this.addWidgetAtPoint(pageIndex, 'video', x, y, { videoObjectUrl: objectUrl });
        return;
      }
      this.insertWidgetPending.set({ kind: 'video', videoObjectUrl: objectUrl });
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to read video.');
      this.pendingVideoWidgetDrop = null;
    }
  }

  protected onSignatureFilePicked(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;

    const widgetId = this.signaturePickTargetWidgetId;
    this.signaturePickTargetWidgetId = null;

    this.errorText.set(null);
    const reader = new FileReader();
    reader.onerror = () => this.errorText.set('Failed to read signature image.');
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      if (!/^data:image\/(png|jpeg);base64,/i.test(dataUrl)) {
        this.errorText.set('Unsupported signature image (use PNG or JPEG).');
        return;
      }
      this.tool.set('text');

      if (widgetId) {
        const pageIndex = this.activePageIndex();
        this.updateWidget(pageIndex, widgetId, (w) => ({ ...w, signatureSrc: dataUrl }));
        this.editingWidgetId.set(null);
        return;
      }

      // Insert signature: click-to-place.
      this.insertWidgetPending.set({ kind: 'signature', imageDataUrl: dataUrl });
    };
    reader.readAsDataURL(file);
  }

  protected beginSignaturePickForWidget(widgetId: string, ev?: Event) {
    ev?.preventDefault?.();
    ev?.stopPropagation?.();
    this.signaturePickTargetWidgetId = widgetId;
    const el = this.widgetSignatureFile?.nativeElement;
    if (el) {
      el.value = '';
      el.click();
    }
  }

  protected insertWidgetModeHint(): string {
    const p = this.insertWidgetPending();
    if (!p) return '';
    if (p.kind === 'image' && !p.imageDataUrl) return 'Choose an image…';
    if (p.kind === 'video' && !p.videoObjectUrl) return 'Choose a video…';
    return 'Click on the page to place.';
  }

  protected cancelInsertWidgetMode() {
    const p = this.insertWidgetPending();
    if (p?.videoObjectUrl) {
      try {
        URL.revokeObjectURL(p.videoObjectUrl);
      } catch {
        // ignore
      }
    }
    this.insertWidgetPending.set(null);
    this.isInserting.set(false);
  }

  private addWidgetAtPoint(
    pageIndex: number,
    kind: WidgetKind,
    centerX: number,
    centerY: number,
    opts?: { imageDataUrl?: string; videoObjectUrl?: string }
  ) {
    const { overlay } = this.getCanvasPair(pageIndex);
    if (!overlay) return;

    const defaults: Record<WidgetKind, { w: number; h: number }> = {
      table: { w: 400, h: 220 },
      image: { w: 220, h: 160 },
      text: { w: 300, h: 160 },
      video: { w: 280, h: 180 },
      signature: { w: 240, h: 110 }
    };
    const d = defaults[kind];
    const rect = overlay.getBoundingClientRect();

    const id = `w_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
    const widget: Widget = {
      id,
      kind,
      x: clamp(centerX - d.w / 2, 0, Math.max(0, rect.width - d.w)),
      y: clamp(centerY - d.h / 2, 0, Math.max(0, rect.height - d.h)),
      w: d.w,
      h: d.h
    };

    if (kind === 'image' && opts?.imageDataUrl) {
      widget.imageSrc = opts.imageDataUrl;
    }
    if (kind === 'video' && opts?.videoObjectUrl) {
      widget.videoSrc = opts.videoObjectUrl;
      this.videoObjectUrlByWidgetId.set(id, opts.videoObjectUrl);
    }
    if (kind === 'signature' && opts?.imageDataUrl) {
      widget.signatureSrc = opts.imageDataUrl;
    }
    if (kind === 'text') {
      widget.textValue = '';
    }
    if (kind === 'table') {
      const rows = 3;
      const cols = 3;
      widget.table = {
        rows,
        cols,
        cells: Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''))
      };
    }

    this.widgetsByPage.update((prev) => {
      const cur = prev[pageIndex] ?? [];
      return { ...prev, [pageIndex]: [...cur, widget] };
    });
    this.selectedWidgetId.set(id);
    if (kind === 'signature') {
      this.editingWidgetId.set(id);
      queueMicrotask(() => this.focusWidgetEditor(id));
    }
    if (kind === 'text') {
      queueMicrotask(() => {
        const el = document.querySelector<HTMLElement>(`[data-widget-id="${id}"] .widget__editor`);
        el?.focus?.();
      });
    }
    if (kind === 'table') {
      queueMicrotask(() => {
        const el = document.querySelector<HTMLInputElement>(
          `[data-widget-id="${id}"] .widget__cell[data-r="0"][data-c="0"]`
        );
        el?.focus?.();
      });
    }

    if (kind === 'image' && opts?.imageDataUrl) {
      void this.loadHtmlImage(opts.imageDataUrl).then((img) => {
        const maxW = 280;
        const nw = maxW;
        const nh = Math.max(10, Math.round((img.height / img.width) * maxW));
        this.patchWidgetSize(pageIndex, id, nw, nh);
      });
    }

    if (kind === 'video' && opts?.videoObjectUrl) {
      const u = opts.videoObjectUrl;
      const vid = document.createElement('video');
      vid.muted = true;
      vid.preload = 'metadata';
      vid.src = u;
      vid.onloadedmetadata = () => {
        const iw = Math.max(1, vid.videoWidth);
        const ih = Math.max(1, vid.videoHeight);
        const targetH = 180;
        const nw = Math.round((iw / ih) * targetH);
        this.patchWidgetSize(pageIndex, id, clamp(nw, 200, 520), targetH);
      };
    }
  }

  private focusWidgetEditor(widgetId: string) {
    const el = document.querySelector<HTMLElement>(`[data-widget-id="${widgetId}"] .widget__editor`);
    el?.focus?.();
  }

  protected startEditingWidget(widgetId: string, ev?: Event) {
    ev?.stopPropagation?.();
    const w = this.getWidget(this.activePageIndex(), widgetId);
    if (w?.kind === 'text' && !this.textFeatureEnabled()) return;

    this.selectedWidgetId.set(widgetId);
    this.editingWidgetId.set(widgetId);
    queueMicrotask(() => this.focusWidgetEditor(widgetId));
  }

  protected stopEditingWidget(widgetId: string) {
    if (this.editingWidgetId() === widgetId) this.editingWidgetId.set(null);
  }

  protected updateTextWidget(pageIndex: number, widgetId: string, value: string) {
    if (!this.textFeatureEnabled()) return;
    this.updateWidget(pageIndex, widgetId, (w) => ({ ...w, textValue: value }));
  }

  protected tableCellValue(w: Widget, r: number, c: number) {
    return w.table?.cells?.[r]?.[c] ?? '';
  }

  protected tableGridTemplateColumns(w: Widget) {
    const cols = Math.max(0, w.table?.cols ?? 0);
    // Excel-like grid: first column is row numbers.
    return `36px repeat(${cols}, minmax(72px, 1fr))`;
  }

  protected tableColLabel(c: number) {
    // 0 -> A, 25 -> Z, 26 -> AA ...
    let n = Math.max(0, Math.floor(c));
    let s = '';
    while (true) {
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
      if (n < 0) break;
    }
    return s;
  }

  protected updateTableCell(pageIndex: number, widgetId: string, r: number, c: number, value: string) {
    this.updateWidget(pageIndex, widgetId, (w) => {
      const t = w.table;
      if (!t) return w;
      const cells = t.cells.map((row) => row.slice());
      if (!cells[r]) return w;
      cells[r][c] = value;
      return { ...w, table: { ...t, cells } };
    });
  }

  protected onTableCellInput(pageIndex: number, widgetId: string, r: number, c: number, ev: Event) {
    const value = (ev.target as HTMLInputElement | null)?.value ?? '';
    this.updateTableCell(pageIndex, widgetId, r, c, value);
  }

  protected onTableCellKeydown(
    pageIndex: number,
    widgetId: string,
    r: number,
    c: number,
    ev: KeyboardEvent
  ) {
    const k = ev.key;
    const dir =
      k === 'ArrowRight'
        ? { dr: 0, dc: 1 }
        : k === 'ArrowLeft'
          ? { dr: 0, dc: -1 }
          : k === 'ArrowDown'
            ? { dr: 1, dc: 0 }
            : k === 'ArrowUp'
              ? { dr: -1, dc: 0 }
              : k === 'Enter'
                ? { dr: 1, dc: 0 }
                : null;

    if (!dir) return;
    ev.preventDefault();
    ev.stopPropagation();

    const w = (this.widgetsByPage()[pageIndex] ?? []).find((x) => x.id === widgetId);
    const rows = Math.max(0, w?.table?.rows ?? 0);
    const cols = Math.max(0, w?.table?.cols ?? 0);
    const nr = clamp(r + dir.dr, 0, Math.max(0, rows - 1));
    const nc = clamp(c + dir.dc, 0, Math.max(0, cols - 1));

    const input = document.querySelector<HTMLInputElement>(
      `[data-widget-id="${widgetId}"] .widget__cell[data-r="${nr}"][data-c="${nc}"]`
    );
    input?.focus?.();
    input?.select?.();
  }

  protected onTableCellPointerDown(widgetId: string, r: number, c: number, ev: PointerEvent) {
    // If we're not in edit mode, a readonly cell can still take focus but won't accept typing.
    // Flip into edit mode and re-focus the clicked cell.
    if (this.editingWidgetId() === widgetId) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.startEditingWidget(widgetId, ev);
    queueMicrotask(() => {
      const input = document.querySelector<HTMLInputElement>(
        `[data-widget-id="${widgetId}"] .widget__cell[data-r="${r}"][data-c="${c}"]`
      );
      input?.focus?.();
      input?.select?.();
    });
  }

  protected addTableRow(pageIndex: number, widgetId: string) {
    this.updateWidget(pageIndex, widgetId, (w) => {
      const t = w.table;
      if (!t) return w;
      const rows = t.rows + 1;
      const cells = t.cells.map((row) => row.slice());
      cells.push(Array.from({ length: t.cols }, () => ''));
      return { ...w, table: { ...t, rows, cells } };
    });
  }

  protected addTableCol(pageIndex: number, widgetId: string) {
    this.updateWidget(pageIndex, widgetId, (w) => {
      const t = w.table;
      if (!t) return w;
      const cols = t.cols + 1;
      const cells = t.cells.map((row) => [...row, '']);
      return { ...w, table: { ...t, cols, cells } };
    });
  }

  private patchWidgetSize(pageIndex: number, widgetId: string, w: number, h: number) {
    const { overlay } = this.getCanvasPair(pageIndex);
    if (!overlay) return;
    const rect = overlay.getBoundingClientRect();
    this.widgetsByPage.update((prev) => {
      const cur = prev[pageIndex] ?? [];
      const idx = cur.findIndex((x) => x.id === widgetId);
      if (idx < 0) return prev;
      const next = cur.slice();
      const it = next[idx]!;
      const cw = clamp(w, 40, rect.width);
      const ch = clamp(h, 40, rect.height);
      next[idx] = {
        ...it,
        w: cw,
        h: ch,
        x: clamp(it.x, 0, Math.max(0, rect.width - cw)),
        y: clamp(it.y, 0, Math.max(0, rect.height - ch))
      };
      return { ...prev, [pageIndex]: next };
    });
  }

  protected onPageStackDragOver(ev: DragEvent) {
    ev.preventDefault();
    try {
      ev.dataTransfer!.dropEffect = 'copy';
    } catch {
      // ignore
    }
  }

  protected onPageStackDrop(pageIndex: number, ev: DragEvent) {
    ev.preventDefault();

    // Dragging from our sidebar "Insert Image" tile.
    const pdfInsert = ev.dataTransfer?.getData('application/x-avyro-pdf-insert') ?? '';
    if (pdfInsert === 'image') {
      const { overlay } = this.getCanvasPair(pageIndex);
      if (!overlay) return;
      const pseudoPointer = { clientX: ev.clientX, clientY: ev.clientY } as PointerEvent;
      const pt = this.eventToPoint(overlay, pseudoPointer);

      const el = this.pdfImageFile?.nativeElement;
      if (!el) return;
      this.pendingPdfImageDrop = { pageIndex, x: pt.x, y: pt.y };
      el.value = '';
      el.click();
      return;
    }

    if (pdfInsert === 'video') {
      const { overlay } = this.getCanvasPair(pageIndex);
      if (!overlay) return;
      const pseudoPointer = { clientX: ev.clientX, clientY: ev.clientY } as PointerEvent;
      const pt = this.eventToPoint(overlay, pseudoPointer);
      const el = this.widgetVideoFile?.nativeElement;
      if (!el) return;
      this.pendingVideoWidgetDrop = { pageIndex, x: pt.x, y: pt.y };
      el.value = '';
      el.click();
      return;
    }

    const raw =
      ev.dataTransfer?.getData('application/x-avyro-widget-kind') ||
      ev.dataTransfer?.getData('text/plain') ||
      '';
    const kind = (['table', 'image', 'text', 'video', 'signature'] as const).includes(raw as any)
      ? (raw as WidgetKind)
      : null;
    if (!kind) {
      const file = ev.dataTransfer?.files?.[0] ?? null;
      if (!file) return;

      const { overlay } = this.getCanvasPair(pageIndex);
      if (!overlay) return;
      const pseudoPointer = { clientX: ev.clientX, clientY: ev.clientY } as PointerEvent;
      const pt = this.eventToPoint(overlay, pseudoPointer);

      if (file.type === 'image/png' || file.type === 'image/jpeg') {
        this.errorText.set(null);
        this.isInserting.set(true);
        const reader = new FileReader();
        reader.onerror = () => {
          this.errorText.set('Failed to read dropped image.');
          this.isInserting.set(false);
        };
        reader.onload = () => {
          const dataUrl = String(reader.result ?? '');
          if (!/^data:image\/(png|jpeg);base64,/i.test(dataUrl)) {
            this.errorText.set('Unsupported image (use PNG or JPEG).');
            this.isInserting.set(false);
            return;
          }
          this.pendingImageDataUrl = dataUrl;
          this.tool.set('image');
          void this.placePendingImage(pageIndex, pt.x, pt.y).finally(() => {
            this.isInserting.set(false);
          });
        };
        reader.readAsDataURL(file);
        return;
      }

      if (file.type.startsWith('video/')) {
        this.errorText.set(null);
        try {
          const objectUrl = URL.createObjectURL(file);
          this.addWidgetAtPoint(pageIndex, 'video', pt.x, pt.y, { videoObjectUrl: objectUrl });
        } catch (e) {
          this.errorText.set(e instanceof Error ? e.message : 'Failed to load video.');
        }
        return;
      }

      this.errorText.set('Drop a PNG, JPEG, or video file.');
      return;
    }

    const { overlay } = this.getCanvasPair(pageIndex);
    if (!overlay) return;

    const pseudoPointer = { clientX: ev.clientX, clientY: ev.clientY } as PointerEvent;
    const pt = this.eventToPoint(overlay, pseudoPointer);
    this.addWidgetAtPoint(pageIndex, kind, pt.x, pt.y);
  }

  protected onWidgetPointerDown(pageIndex: number, widgetId: string, ev: PointerEvent) {
    const t = ev.target as HTMLElement | null;
    // Clicks on "Add text" / "Edit table" / signature upload bubble here; if we start a move
    // the button never receives a proper click, so you cannot re-open edit after blur.
    if (t?.closest('button, a, input, textarea, select, label[for]')) {
      return;
    }
    ev.stopPropagation();
    ev.preventDefault();
    this.selectedWidgetId.set(widgetId);
    this.beginWidgetMove(pageIndex, widgetId, ev);
  }

  protected onWidgetHeaderPointerDown(pageIndex: number, widgetId: string, ev: PointerEvent) {
    ev.stopPropagation();
    ev.preventDefault();
    this.selectedWidgetId.set(widgetId);
    this.beginWidgetMove(pageIndex, widgetId, ev);
  }

  protected onWidgetResizePointerDown(
    pageIndex: number,
    widgetId: string,
    edge: WidgetResizeEdge,
    ev: PointerEvent
  ) {
    ev.stopPropagation();
    ev.preventDefault();
    this.selectedWidgetId.set(widgetId);

    const { overlay } = this.getCanvasPair(pageIndex);
    if (!overlay) return;
    const pt = this.eventToPoint(overlay, ev);
    const w = this.getWidget(pageIndex, widgetId);
    if (!w) return;

    (ev.target as HTMLElement | null)?.setPointerCapture?.(ev.pointerId);
    this.activeWidgetOp = {
      pageIndex,
      id: widgetId,
      pointerId: ev.pointerId,
      mode: 'resize',
      resizeEdge: edge,
      startX: pt.x,
      startY: pt.y,
      origX: w.x,
      origY: w.y,
      origW: w.w,
      origH: w.h
    };
  }

  protected removeWidget(pageIndex: number, widgetId: string) {
    const before = this.getWidget(pageIndex, widgetId);
    if (before?.kind === 'video' && before.videoSrc) {
      const url = this.videoObjectUrlByWidgetId.get(widgetId) ?? before.videoSrc;
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
      this.videoObjectUrlByWidgetId.delete(widgetId);
    }

    this.widgetsByPage.update((prev) => {
      const cur = prev[pageIndex] ?? [];
      const next = cur.filter((w) => w.id !== widgetId);
      return { ...prev, [pageIndex]: next };
    });
    if (this.selectedWidgetId() === widgetId) this.selectedWidgetId.set(null);
  }

  protected readonly toolbarItems: ToolbarItem[] = [
    {
      kind: 'button',
      id: 'undo',
      title: 'Undo',
      icon: 'undo',
      onClick: () => this.undo(),
      disabled: () => !this.canUndo()
    },
    {
      kind: 'button',
      id: 'redo',
      title: 'Redo',
      icon: 'redo',
      onClick: () => this.redo(),
      disabled: () => !this.canRedo()
    },
    { kind: 'sep', id: 'sep-1' },
    {
      kind: 'button',
      id: 'print',
      title: 'Print (Clear edits)',
      icon: 'print',
      onClick: () => this.clearEdits(),
      disabled: () => this.pageCount() === 0
    },
    {
      kind: 'button',
      id: 'extract-template',
      title: 'Extract template',
      icon: 'template',
      onClick: () => void this.extractTemplate(),
      disabled: () => this.pageCount() === 0 || this.isLoading() || this.isSaving()
    },
    {
      kind: 'button',
      id: 'spellcheck',
      title: 'Spellcheck (noop)',
      icon: 'spellcheck',
      onClick: () => {}
    },
    { kind: 'sep', id: 'sep-2' },
    {
      kind: 'group',
      id: 'zoom',
      items: [
        {
          kind: 'button',
          id: 'zoom-out',
          title: 'Zoom out',
          icon: 'zoomOut',
          onClick: () => this.scale.set(Math.max(0.75, this.scale() - 0.1))
        },
        {
          kind: 'select',
          id: 'zoom-select',
          title: 'Zoom',
          value: () => this.scale(),
          setValue: (v) => this.scale.set(v),
          options: this.zoomOptions.map((z) => ({ label: `${(z * 100).toFixed(0)}%`, value: z }))
        },
        {
          kind: 'button',
          id: 'zoom-in',
          title: 'Zoom in',
          icon: 'zoomIn',
          onClick: () => this.scale.set(Math.min(2.5, this.scale() + 0.1))
        }
      ]
    },
    { kind: 'sep', id: 'sep-3' },
    {
      kind: 'select',
      id: 'paragraph-style',
      title: 'Paragraph style',
      value: () => 'Normal text',
      setValue: () => {},
      options: [{ label: 'Normal text', value: 'Normal text' }],
      disabled: () => !this.textFeatureEnabled()
    },
    {
      kind: 'select',
      id: 'font-family',
      title: 'Font family',
      value: () => this.textFamily(),
      setValue: (v) => this.setTextFamily(v as FontFamily),
      options: this.fontFamilyOptions,
      disabled: () => !this.textFeatureEnabled()
    },
    {
      kind: 'select',
      id: 'font-size',
      title: 'Font size',
      value: () => this.textSize(),
      setValue: (v) => this.textSize.set(Number(v)),
      options: this.fontSizeOptions.map((s) => ({ label: String(s), value: s })),
      disabled: () => !this.textFeatureEnabled()
    },
    { kind: 'sep', id: 'sep-4' },
    {
      kind: 'button',
      id: 'bold',
      title: 'Bold',
      icon: 'bold',
      onClick: () => this.toggleBold(),
      active: () => this.textWeight() === 700,
      disabled: () => !this.textFeatureEnabled()
    },
    {
      kind: 'button',
      id: 'italic',
      title: 'Italic',
      icon: 'italic',
      onClick: () => this.toggleItalic(),
      active: () => this.textStyle() === 'italic' || this.textStyle() === 'boldItalic',
      disabled: () => !this.textFeatureEnabled()
    },
    {
      kind: 'button',
      id: 'toggle-bg',
      title: 'Background color',
      icon: 'bgColor',
      onClick: () => this.toggleTextBgEnabled(),
      active: () => this.textBgEnabled(),
      disabled: () => !this.textFeatureEnabled()
    },
    {
      kind: 'color',
      id: 'bg-color',
      title: 'Background color picker',
      value: () => this.textBgColor(),
      setValue: (v) => this.textBgColor.set(v),
      disabled: () => !this.textFeatureEnabled() || !this.textBgEnabled()
    },
    {
      kind: 'button',
      id: 'text-color-icon',
      title: 'Text color',
      icon: 'textColor',
      onClick: () => {},
      disabled: () => !this.textFeatureEnabled()
    },
    {
      kind: 'color',
      id: 'text-color',
      title: 'Font color',
      value: () => this.textColor(),
      setValue: (v) => this.textColor.set(v),
      disabled: () => !this.textFeatureEnabled()
    },
    { kind: 'sep', id: 'sep-5' },
    {
      kind: 'file',
      id: 'insert-image',
      title: 'Insert image',
      icon: 'image',
      accept: 'image/png,image/jpeg',
      onChange: (ev) => void this.onPickImageFile(ev)
    },
    { kind: 'sep', id: 'sep-6' },
    {
      kind: 'button',
      id: 'tool-pen',
      title: 'Pen tool',
      icon: 'pen',
      onClick: () => this.tool.set('pen'),
      active: () => this.tool() === 'pen'
    },
    {
      kind: 'button',
      id: 'tool-text',
      title: 'Text tool',
      icon: 'text',
      onClick: () => this.tool.set('text'),
      active: () => this.tool() === 'text',
      disabled: () => !this.textFeatureEnabled()
    },
    {
      kind: 'button',
      id: 'tool-pan',
      title: 'Pan tool',
      icon: 'pan',
      onClick: () => this.tool.set('pan'),
      active: () => this.tool() === 'pan'
    }
  ];

  ngAfterViewInit(): void {
    // If the canvas lists change (after PDF load), render.
    this.pageCanvases?.changes.subscribe(() => void this.renderActivePage());
    this.overlayCanvases?.changes.subscribe(() => void this.renderActivePage());

    // On hard refresh, the PDF can finish loading before the initial QueryList `changes` fires.
    // Do an initial best-effort render once the view is ready.
    queueMicrotask(() => void this.renderActivePage());

    this.destroyRef.onDestroy(() => {
      if (this.slideToastClearTimer !== null) {
        clearTimeout(this.slideToastClearTimer);
        this.slideToastClearTimer = null;
      }
      try {
        this.pdfDoc?.destroy();
      } catch {
        // ignore
      }
      for (const url of this.videoObjectUrlByWidgetId.values()) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
      this.videoObjectUrlByWidgetId.clear();
    });
  }

  protected async onPickFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    if (!file) return;

    this.errorText.set(null);
    this.isLoading.set(true);
    this.fileName.set(file.name);

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      this.assertReadablePdfHeader(bytes);
      this.pdfBytes = this.clonePdfBytes(bytes);

      // Use a throwaway copy for pdf.js; it may transfer/detach buffers.
      const forPdfJs = this.clonePdfBytes(this.pdfBytes);
      const loadingTask = getDocument({ data: forPdfJs });
      const doc = await loadingTask.promise;
      this.pdfDoc = doc;

      this.pageCount.set(doc.numPages);
      this.activePageIndex.set(0);
      this.openPageMenuIndex.set(null);
      this.sidebarSlideMenuOpenIndex.set(null);
      this.pageThumbUrlByPage.set({});
      this.editsByPage.set({});
      this.resetHistory();
      void this.generateAllPageThumbnails();

      // Rendering will happen via QueryList changes.
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to load PDF.');
      this.pdfBytes = null;
      this.pdfDoc = null;
      this.pageCount.set(0);
    } finally {
      this.isLoading.set(false);
      input.value = '';
    }
  }

  protected backToLibrary() {
    void this.router.navigate(['/']);
  }

  private async loadFromApi(id: string) {
    this.errorText.set(null);
    this.isLoading.set(true);
    try {
      const [meta, bytes] = await Promise.all([this.api.getMeta(id), this.api.getBytes(id)]);

      this.fileName.set(meta.name);
      this.assertReadablePdfHeader(bytes);
      this.pdfBytes = this.clonePdfBytes(bytes);

      const forPdfJs = this.clonePdfBytes(this.pdfBytes);
      const loadingTask = getDocument({ data: forPdfJs });
      const doc = await loadingTask.promise;
      this.pdfDoc = doc;

      this.pageCount.set(doc.numPages);
      this.activePageIndex.set(0);
      this.openPageMenuIndex.set(null);
      this.sidebarSlideMenuOpenIndex.set(null);
      this.pageThumbUrlByPage.set({});
      this.editsByPage.set({});
      this.resetHistory();
      void this.generateAllPageThumbnails();

      // Ensure the first page is fully rendered before we drop the loading banner.
      await this.waitForActiveCanvasReady(1600);
      await this.renderActivePage();
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to load PDF.');
      this.pdfBytes = null;
      this.pdfDoc = null;
      this.pageCount.set(0);
    } finally {
      this.isLoading.set(false);
    }
  }

  private async waitForActiveCanvasReady(timeoutMs = 1200) {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      const base = this.pageCanvases?.get(0)?.nativeElement ?? null;
      const overlay = this.overlayCanvases?.get(0)?.nativeElement ?? null;
      if (base && overlay) {
        const w = base.getBoundingClientRect().width;
        const h = base.getBoundingClientRect().height;
        if (w > 10 && h > 10) return;
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }

  private async persistPdfBytesToBackend() {
    const id = this.docId();
    if (!id) return;
    if (!this.pdfBytes) return;
    try {
      await this.api.saveBytes(id, this.pdfBytes);
    } catch (e) {
      // Non-fatal: user can still export/download.
      this.errorText.set(e instanceof Error ? e.message : 'Failed to save PDF.');
    }
  }

  protected clearEdits() {
    this.beginHistoryStep();
    this.editsByPage.set({});
    this.pendingVideoWidgetDrop = null;
    this.selectedPlacedImageId.set(null);
    this.imageCropSession.set(null);
    this.activePlacedImageOp = null;
    // Restore original page renders (replaces are drawn directly onto the base canvas).
    for (let pageIndex = 0; pageIndex < this.pageCount(); pageIndex++) {
      this.restoreBaseFromSnapshot(pageIndex);
    }
    this.redrawAllOverlays();
  }

  protected canUndo() {
    return this.undoStack.length > 0;
  }

  protected canRedo() {
    return this.redoStack.length > 0;
  }

  protected undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    const cur = this.cloneEdits(this.editsByPage());
    this.redoStack.push(cur);
    this.editsByPage.set(prev);
    this.afterHistoryRestore();
  }

  protected redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    const cur = this.cloneEdits(this.editsByPage());
    this.undoStack.push(cur);
    this.editsByPage.set(next);
    this.afterHistoryRestore();
  }

  @HostListener('window:keydown', ['$event'])
  protected onWindowKeyDown(ev: KeyboardEvent) {
    // Avoid hijacking shortcuts while typing in inputs/textareas/contenteditable.
    const target = ev.target as HTMLElement | null;
    const tag = (target?.tagName ?? '').toLowerCase();
    const isTyping =
      tag === 'input' ||
      tag === 'textarea' ||
      Boolean((target as any)?.isContentEditable);
    if (isTyping) return;

    if (ev.key === 'Escape') {
      if (this.deleteSlideModalOpen()) {
        this.closeDeleteSlideModal();
        return;
      }
      if (this.sidebarSlideMenuOpenIndex() !== null) {
        this.sidebarSlideMenuOpenIndex.set(null);
        return;
      }
      this.cancelInsertWidgetMode();
      return;
    }

    const mod = ev.metaKey || ev.ctrlKey;
    if (!mod) return;

    const key = ev.key.toLowerCase();
    if (key === 'z') {
      ev.preventDefault();
      if (ev.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (key === 'y') {
      ev.preventDefault();
      this.redo();
    }
  }

  private resetHistory() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  protected setActivePage(pageIndex: number) {
    const next = clamp(pageIndex, 0, Math.max(0, this.pageCount() - 1));
    this.activePageIndex.set(next);
    this.openPageMenuIndex.set(null);
    this.sidebarSlideMenuOpenIndex.set(null);
  }

  protected togglePageMenu(pageIndex: number, ev?: Event) {
    ev?.stopPropagation?.();
    const cur = this.openPageMenuIndex();
    this.openPageMenuIndex.set(cur === pageIndex ? null : pageIndex);
  }

  protected closePageMenu() {
    this.openPageMenuIndex.set(null);
  }

  protected toggleSidebarSlideMenu(pageIndex: number, ev: Event) {
    ev.stopPropagation();
    if (this.isLoading() || this.isSaving()) return;
    const cur = this.sidebarSlideMenuOpenIndex();
    this.sidebarSlideMenuOpenIndex.set(cur === pageIndex ? null : pageIndex);
  }

  /** Remove slide via the same confirmation flow as before (was ✕ button). */
  protected onSidebarMenuRemoveSlide(pageIndex: number, ev: Event) {
    ev.stopPropagation();
    this.sidebarSlideMenuOpenIndex.set(null);
    this.requestDeleteSlide(pageIndex, ev);
  }

  protected async onSidebarDuplicateSlide(pageIndex: number, ev: Event) {
    ev.stopPropagation();
    if (!this.pdfBytes || this.isLoading() || this.isSaving()) return;
    this.sidebarSlideMenuOpenIndex.set(null);
    await this.copyPageAfter(pageIndex);
    if (!this.errorText()) {
      this.showSlideToast('Slide duplicated');
    }
  }

  protected async onSidebarAddSlide(pageIndex: number, ev: Event) {
    ev.stopPropagation();
    if (!this.pdfBytes || this.isLoading() || this.isSaving()) return;
    this.sidebarSlideMenuOpenIndex.set(null);
    await this.addBlankPageAfter(pageIndex);
    if (!this.errorText()) {
      this.showSlideToast('Slide added');
    }
  }

  protected scrollToPage(_pageIndex: number) {
    // Single-page mode: nothing to scroll; page switching is handled via `activePageIndex`.
  }

  private beginHistoryStep() {
    // Save the current state so Undo can restore it.
    const snap = this.cloneEdits(this.editsByPage());
    this.undoStack.push(snap);
    if (this.undoStack.length > this.maxHistoryEntries) {
      this.undoStack.splice(0, this.undoStack.length - this.maxHistoryEntries);
    }
    this.redoStack.length = 0;
  }

  private cloneEdits(edits: Record<number, PageEdits>) {
    // Use structuredClone when available; fall back to JSON for plain data.
    try {
      return structuredClone(edits);
    } catch {
      return JSON.parse(JSON.stringify(edits)) as Record<number, PageEdits>;
    }
  }

  private afterHistoryRestore() {
    // Cancel any in-progress interactions to avoid weird state after revert.
    this.activeInk = null;
    this.editingReplace = null;
    this.isTextPlacing.set(false);
    this.textDraft.set('');
    this.textDraftPageIndex.set(null);
    this.textDraftBox = null;
    this.isImagePlacing.set(false);
    this.pendingImageDataUrl = null;
    this.pendingPdfImageDrop = null;
    this.pendingVideoWidgetDrop = null;
    this.activePlacedImageOp = null;
    this.selectedPlacedImageId.set(null);
    this.imageCropSession.set(null);

    // Restore base pages then re-apply replaces based on restored state.
    for (let pageIndex = 0; pageIndex < this.pageCount(); pageIndex++) {
      this.restoreBaseFromSnapshot(pageIndex);
      this.applyReplacesToBase(pageIndex);
      this.redrawOverlay(pageIndex);
    }
  }

  private exportNeedsFlatten(opts?: {
    edits?: Record<number, PageEdits>;
    widgetsByPage?: Record<number, Widget[]>;
  }): boolean {
    const widgetsByPage = opts?.widgetsByPage ?? this.widgetsByPage();
    const editsByPage = opts?.edits ?? this.editsByPage();
    const hasWidgets = Object.values(widgetsByPage).some((list) => (list ?? []).length > 0);
    if (hasWidgets) return true;
    return Object.values(editsByPage).some((e) => (e?.replaces ?? []).some((r) => r.maskMode === 'inpaint'));
  }

  /** Semantic PDF with annotations (pen, text, images, etc.). Not used when `exportNeedsFlatten()`. */
  private async buildSemanticExportBytes(editsOverride?: Record<number, PageEdits>): Promise<Uint8Array> {
    if (!this.pdfBytes) throw new Error('PDF not loaded.');
    this.assertReadablePdfHeader(this.pdfBytes);
    const edits = editsOverride ?? this.editsByPage();
    const pdf = await PDFDocument.load(this.clonePdfBytes(this.pdfBytes));
      const fontsByFamily: Record<
        Exclude<FontFamily, 'poppins' | 'montserrat' | 'abcdee_helvetica_bold'>,
        Record<FontStyle, PDFFont>
      > = {
        helvetica: {
          regular: await pdf.embedFont(StandardFonts.Helvetica),
          bold: await pdf.embedFont(StandardFonts.HelveticaBold),
          italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
          boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique)
        },
        times: {
          regular: await pdf.embedFont(StandardFonts.TimesRoman),
          bold: await pdf.embedFont(StandardFonts.TimesRomanBold),
          italic: await pdf.embedFont(StandardFonts.TimesRomanItalic),
          boldItalic: await pdf.embedFont(StandardFonts.TimesRomanBoldItalic)
        },
        courier: {
          regular: await pdf.embedFont(StandardFonts.Courier),
          bold: await pdf.embedFont(StandardFonts.CourierBold),
          italic: await pdf.embedFont(StandardFonts.CourierOblique),
          boldItalic: await pdf.embedFont(StandardFonts.CourierBoldOblique)
        }
      };

      const pages = pdf.getPages();

      for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const page = pages[pageIndex];
        const edit = edits[pageIndex];
        if (!edit) continue;

        // If we neutralized a bogus 180° page rotation in the editor view,
        // do the same in the exported PDF so it doesn't re-flip in viewers.
        const originalRotate = this.pageRotateByPage.get(pageIndex) ?? 0;
        if (((originalRotate % 360) + 360) % 360 === 180) {
          try {
            page.setRotation(degrees(0));
          } catch {
            // ignore
          }
        }

        const { width, height } = page.getSize();
        const sx = width / edit.viewportWidth;
        const sy = height / edit.viewportHeight;

        // Replace text first (cover original area, then draw new).
        for (const r of edit.replaces) {
          // NOTE: In semantic PDF export, we can only do a flat rectangle mask.
          // For scanned/image PDFs we should prefer a flatten export instead of 'inpaint' masking.
          const bg = hexToRgb01(r.bgColor);
          page.drawRectangle({
            x: r.x * sx,
            y: height - (r.y + r.h) * sy,
            width: r.w * sx,
            height: r.h * sy,
            color: rgb(bg.r, bg.g, bg.b)
          });

          if (r.newText.length > 0) {
            const c = hexToRgb01(r.color);
            const familyRaw: FontFamily = r.fontFamily ?? 'helvetica';
            const family: Exclude<FontFamily, 'poppins' | 'montserrat'> =
              familyRaw === 'poppins' || familyRaw === 'montserrat' || familyRaw === 'abcdee_helvetica_bold'
                ? 'helvetica'
                : familyRaw;
            const font = fontsByFamily[family]?.[r.fontStyle] ?? fontsByFamily.helvetica.regular;
            page.drawText(r.newText, {
              x: r.x * sx,
              y: height - r.y * sy - r.fontSize * sy,
              size: r.fontSize * sy,
              font,
              color: rgb(c.r, c.g, c.b)
            });
          }
        }

        await this.drawImagesToPdf(pdf, page, edit, sx, sy);

        for (const stroke of edit.ink) {
          const c = hexToRgb01(stroke.color);
          for (let i = 1; i < stroke.points.length; i++) {
            const a = stroke.points[i - 1];
            const b = stroke.points[i];
            page.drawLine({
              start: { x: a.x * sx, y: height - a.y * sy },
              end: { x: b.x * sx, y: height - b.y * sy },
              thickness: Math.max(0.5, stroke.width * sx),
              color: rgb(c.r, c.g, c.b)
            });
          }
        }

        for (const t of edit.text) {
          const c = hexToRgb01(t.color);
          const familyRaw: FontFamily = t.fontFamily ?? 'helvetica';
          const family: Exclude<FontFamily, 'poppins' | 'montserrat'> =
            familyRaw === 'poppins' || familyRaw === 'montserrat' || familyRaw === 'abcdee_helvetica_bold'
              ? 'helvetica'
              : familyRaw;
          const font = fontsByFamily[family]?.[t.fontStyle] ?? fontsByFamily.helvetica.regular;
          const size = t.fontSize * sy;

          // Optional background fill behind text (best-effort bbox).
          if (t.bgColor) {
            const bg = hexToRgb01(t.bgColor);
            const lines = t.text.split('\n');
            const lh = Math.max(1, Math.round(size * 1.2));
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i] ?? '';
              const w = font.widthOfTextAtSize(line, size);
              page.drawRectangle({
                x: t.x * sx,
                y: height - t.y * sy - size - i * lh,
                width: w,
                height: lh,
                color: rgb(bg.r, bg.g, bg.b)
              });
            }
          }

          page.drawText(t.text, {
            x: t.x * sx,
            y: height - t.y * sy - size,
            size,
            font,
            color: rgb(c.r, c.g, c.b)
          });
        }
      }

    const out = await pdf.save();
    const safeBytes = new Uint8Array(out.byteLength);
    safeBytes.set(out);
    return safeBytes;
  }

  /**
   * Rasterize each page and rebuild a PDF (required when inpaint masking is used).
   */
  private async buildFlattenedExportBytes(
    editsOverride?: Record<number, PageEdits>,
    widgetsOverride?: Record<number, Widget[]>
  ): Promise<Uint8Array> {
    if (!this.pdfBytes || !this.pdfDoc) throw new Error('PDF not loaded.');

    // Load original for page sizes.
    this.assertReadablePdfHeader(this.pdfBytes);
    const srcPdf = await PDFDocument.load(this.clonePdfBytes(this.pdfBytes));
    const outPdf = await PDFDocument.create();

    const srcPages = srcPdf.getPages();
    const edits = editsOverride ?? this.editsByPage();
    const widgetsByPage = widgetsOverride ?? this.widgetsByPage();

    // Render at higher scale for better quality.
    const renderScale = Math.max(2, this.scale());

    for (let pageIndex = 0; pageIndex < srcPages.length; pageIndex++) {
      const srcPage = srcPages[pageIndex];
      const { width, height } = srcPage.getSize();
      const edit = edits[pageIndex];

      // Render original page via pdf.js.
      const page = await this.pdfDoc.getPage(pageIndex + 1);
      const originalRotate = ((page.rotate ?? 0) % 360 + 360) % 360;
      const rotation = originalRotate === 180 ? 0 : originalRotate;
      const viewport = page.getViewport({ scale: renderScale, rotation });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable.');

      await page.render({ canvasContext: ctx, viewport, canvas }).promise;

      // Composite edits + widgets in viewport coordinates.
      if (edit) {
        const fx = viewport.width / edit.viewportWidth;
        const fy = viewport.height / edit.viewportHeight;

        // Replaces (color or inpaint)
        for (const r of edit.replaces) {
          const rx = r.x * fx;
          const ry = r.y * fy;
          const rw = r.w * fx;
          const rh = r.h * fy;

          if (r.maskMode === 'inpaint') {
            this.inpaintRect(ctx, canvas, rx, ry, rw, rh);
          } else {
            ctx.fillStyle = r.bgColor;
            ctx.fillRect(rx, ry, rw, rh);
          }

          if (r.newText.length > 0) {
            ctx.fillStyle = r.color;
            const style = r.fontStyle.includes('italic') ? 'italic' : 'normal';
            const weight = r.fontStyle.includes('bold') ? '700' : '400';
            ctx.font = `${style} ${weight} ${r.fontSize * fy}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI"`;
            ctx.textBaseline = 'top';
            const lines = r.newText.split('\n');
            const lh = Math.max(1, Math.round(r.fontSize * fy * 1.2));
            for (let i = 0; i < lines.length; i++) {
              ctx.fillText(lines[i], rx, ry + i * lh);
            }
          }
        }

        // Ink
        for (const stroke of edit.ink) {
          if (stroke.points.length < 2) continue;
          ctx.strokeStyle = stroke.color;
          ctx.lineWidth = stroke.width * fx;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(stroke.points[0].x * fx, stroke.points[0].y * fy);
          for (let i = 1; i < stroke.points.length; i++) {
            const p = stroke.points[i];
            ctx.lineTo(p.x * fx, p.y * fy);
          }
          ctx.stroke();
        }

        // Images
        for (const img of edit.images) {
          const image = await this.loadHtmlImage(img.dataUrl);
          const { sx, sy, sw, sh } = this.getSourceRectForPlaced(img, image);
          ctx.drawImage(
            image,
            sx,
            sy,
            sw,
            sh,
            img.x * fx,
            img.y * fy,
            img.w * fx,
            img.h * fy
          );
        }

        // New text annotations
        for (const t of edit.text) {
          ctx.fillStyle = t.color;
          const style = t.fontStyle.includes('italic') ? 'italic' : 'normal';
          const weight = t.fontStyle.includes('bold') ? '700' : '400';
          ctx.font = `${style} ${weight} ${t.fontSize * fy}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI"`;
          ctx.textBaseline = 'top';
          ctx.fillText(t.text, t.x * fx, t.y * fy);
        }

        // Widgets (table/text/image/signature/video)
        await this.drawWidgetsToFlattenCanvas(pageIndex, ctx, fx, fy, widgetsByPage);
      }

      // Embed rendered page image into output PDF page at original size.
      const pngDataUrl = canvas.toDataURL('image/png');
      const { bytes } = this.dataUrlToBytes(pngDataUrl);
      const embedded = await outPdf.embedPng(bytes);
      const outPage = outPdf.addPage([width, height]);
      outPage.drawImage(embedded, { x: 0, y: 0, width, height });
    }

    const out = await outPdf.save();
    const safeBytes = new Uint8Array(out.byteLength);
    safeBytes.set(out);
    return safeBytes;
  }

  private async drawWidgetsToFlattenCanvas(
    pageIndex: number,
    ctx: CanvasRenderingContext2D,
    fx: number,
    fy: number,
    widgetsByPageOverride?: Record<number, Widget[]>
  ) {
    const widgetsByPage = widgetsByPageOverride ?? this.widgetsByPage();
    const widgets = widgetsByPage[pageIndex] ?? [];
    if (widgets.length === 0) return;

    for (const w of widgets) {
      const x = w.x * fx;
      const y = w.y * fy;
      const ww = w.w * fx;
      const hh = w.h * fy;

      // Widget background (so text/table reads nicely over PDF).
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillRect(x, y, ww, hh);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.22)';
      ctx.lineWidth = Math.max(1, 1 * Math.min(fx, fy));
      ctx.strokeRect(x, y, ww, hh);
      ctx.restore();

      if (w.kind === 'image' && w.imageSrc) {
        try {
          const img = await this.loadHtmlImage(w.imageSrc);
          ctx.drawImage(img, x + 4, y + 4, Math.max(1, ww - 8), Math.max(1, hh - 8));
        } catch {
          // ignore
        }
        continue;
      }

      if (w.kind === 'signature' && w.signatureSrc) {
        try {
          const img = await this.loadHtmlImage(w.signatureSrc);
          ctx.drawImage(img, x + 4, y + 4, Math.max(1, ww - 8), Math.max(1, hh - 8));
        } catch {
          // ignore
        }
        continue;
      }

      if (w.kind === 'text') {
        const text = String(w.textValue ?? '');
        ctx.save();
        ctx.fillStyle = 'rgba(15,23,42,0.92)';
        const fontSize = Math.max(10, Math.round(14 * Math.min(fx, fy)));
        ctx.font = `${fontSize}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI"`;
        ctx.textBaseline = 'top';
        const pad = 8 * Math.min(fx, fy);
        const lines = text.split('\n');
        const lh = Math.max(1, Math.round(fontSize * 1.25));
        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i] ?? '', x + pad, y + pad + i * lh);
        }
        ctx.restore();
        continue;
      }

      if (w.kind === 'table' && w.table) {
        const rows = w.table.rows;
        const cols = w.table.cols;
        if (rows <= 0 || cols <= 0) continue;
        const pad = 6 * Math.min(fx, fy);
        const gridX = x + pad;
        const gridY = y + pad;
        const gridW = Math.max(1, ww - pad * 2);
        const gridH = Math.max(1, hh - pad * 2);
        const cellW = gridW / cols;
        const cellH = Math.max(18 * Math.min(fx, fy), gridH / rows);
        ctx.save();
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.22)';
        ctx.lineWidth = Math.max(1, 1 * Math.min(fx, fy));
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        const fontSize = Math.max(10, Math.round(12 * Math.min(fx, fy)));
        ctx.font = `${fontSize}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI"`;
        ctx.textBaseline = 'middle';
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const cx = gridX + c * cellW;
            const cy = gridY + r * cellH;
            ctx.strokeRect(cx, cy, cellW, cellH);
            const v = w.table.cells?.[r]?.[c] ?? '';
            if (v) ctx.fillText(v, cx + 6 * Math.min(fx, fy), cy + cellH / 2);
          }
        }
        ctx.restore();
        continue;
      }

      if (w.kind === 'video' && w.videoSrc) {
        // Best-effort: draw the first frame. If it fails, draw a placeholder.
        try {
          const v = document.createElement('video');
          v.muted = true;
          v.playsInline = true;
          v.preload = 'metadata';
          v.src = w.videoSrc;
          await new Promise<void>((resolve, reject) => {
            const onOk = () => resolve();
            const onErr = () => reject(new Error('video'));
            v.onloadeddata = onOk;
            v.onerror = onErr;
          });
          ctx.drawImage(v, x + 4, y + 4, Math.max(1, ww - 8), Math.max(1, hh - 8));
        } catch {
          ctx.save();
          ctx.fillStyle = 'rgba(15,23,42,0.85)';
          ctx.fillRect(x + 4, y + 4, Math.max(1, ww - 8), Math.max(1, hh - 8));
          ctx.fillStyle = 'rgba(255,255,255,0.95)';
          ctx.beginPath();
          ctx.moveTo(x + ww / 2 - 10, y + hh / 2 - 14);
          ctx.lineTo(x + ww / 2 - 10, y + hh / 2 + 14);
          ctx.lineTo(x + ww / 2 + 16, y + hh / 2);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }
    }
  }

  protected async exportPdf() {
    if (!this.pdfBytes) return;
    this.errorText.set(null);
    this.isLoading.set(true);

    try {
      const safeBytes = this.exportNeedsFlatten()
        ? await this.buildFlattenedExportBytes()
        : await this.buildSemanticExportBytes();

      // Best-effort: persist the exported result for library documents.
      const id = this.docId();
      if (id) {
        void this.api.saveBytes(id, safeBytes).catch(() => {
          // ignore
        });
      }

      // Some builds type pdf-lib output buffers as ArrayBufferLike (SharedArrayBuffer),
      // which TS won't accept as BlobPart. Force a real ArrayBuffer-backed copy.
      const blobBytes = new Uint8Array(safeBytes.byteLength);
      blobBytes.set(safeBytes);
      const blob = new Blob([blobBytes.buffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = this.fileName() ? this.fileName()!.replace(/\.pdf$/i, '') + '-edited.pdf' : 'edited.pdf';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to export PDF.');
    } finally {
      this.isLoading.set(false);
    }
  }

  protected async extractTemplate() {
    if (!this.pdfBytes || this.pageCount() === 0) return;

    const baseName = (this.fileName() ?? 'Document').replace(/\.pdf$/i, '');
    const templateName = (prompt('Template name', `${baseName} Template`) ?? '').trim();
    if (!templateName) return;
    const tagsCsv = (prompt('Tags (comma-separated)', '') ?? '').trim();

    this.errorText.set(null);
    this.isLoading.set(true);

    try {
      const cleanedEdits = this.buildTemplateEdits(this.editsByPage());
      const cleanedWidgets = this.buildTemplateWidgets(this.widgetsByPage());

      const safeBytes = this.exportNeedsFlatten({ edits: cleanedEdits, widgetsByPage: cleanedWidgets })
        ? await this.buildFlattenedExportBytes(cleanedEdits, cleanedWidgets)
        : await this.buildSemanticExportBytes(cleanedEdits);

      const blobBytes = new Uint8Array(safeBytes.byteLength);
      blobBytes.set(safeBytes);
      const blob = new Blob([blobBytes.buffer], { type: 'application/pdf' });
      const file = new File([blob], `${templateName.replace(/\.pdf$/i, '')}.pdf`, { type: 'application/pdf' });

      const meta = await this.api.upload(file);
      this.assetMeta.setTemplateMeta(meta.id, { templateName, tagsCsv });

      await this.router.navigate(['/edit', meta.id]);
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to extract template.');
    } finally {
      this.isLoading.set(false);
    }
  }

  private buildTemplateEdits(src: Record<number, PageEdits>): Record<number, PageEdits> {
    // Wipe "content" while preserving geometry + typography choices.
    // - text annotations: keep style/position, clear text
    // - replaces: keep mask + style + box, clear newText so the region is blank
    // - ink/images: cleared (these are usually user-specific content)
    const out: Record<number, PageEdits> = {};
    for (const [k, v] of Object.entries(src)) {
      const pageIndex = Number(k);
      if (!v) continue;
      out[pageIndex] = {
        ...v,
        ink: [],
        images: [],
        text: (v.text ?? []).map((t) => ({ ...t, text: '' })),
        replaces: (v.replaces ?? []).map((r) => ({ ...r, newText: '' }))
      };
    }
    return out;
  }

  private buildTemplateWidgets(src: Record<number, Widget[]>): Record<number, Widget[]> {
    const out: Record<number, Widget[]> = {};
    for (const [k, list] of Object.entries(src)) {
      const pageIndex = Number(k);
      const widgets = (list ?? []).map((w) => {
        if (w.kind === 'text') return { ...w, textValue: '' };
        if (w.kind === 'table' && w.table) {
          const rows = w.table.rows;
          const cols = w.table.cols;
          return {
            ...w,
            table: {
              rows,
              cols,
              cells: Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''))
            }
          };
        }
        if (w.kind === 'image') return { ...w, imageSrc: undefined };
        if (w.kind === 'signature') return { ...w, signatureSrc: undefined };
        if (w.kind === 'video') return { ...w, videoSrc: undefined };
        return { ...w };
      });
      out[pageIndex] = widgets;
    }
    return out;
  }

  protected readonly isSaving = signal(false);

  /** Save the current document (including annotations) to the server. Requires a library document id. */
  protected async savePdfToDb() {
    const id = this.docId();
    if (!id) {
      this.errorText.set('Open a document from the library to save to the server.');
      return;
    }
    if (!this.pdfBytes || this.pageCount() === 0) return;

    this.errorText.set(null);
    this.isSaving.set(true);
    try {
      const safeBytes = this.exportNeedsFlatten()
        ? await this.buildFlattenedExportBytes()
        : await this.buildSemanticExportBytes();
      await this.api.saveBytes(id, safeBytes);
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to save PDF.');
    } finally {
      this.isSaving.set(false);
    }
  }

  private getCanvasPair(pageIndex: number) {
    // Single-page mode: there is only one canvas pair, mapped to the active page index.
    if (pageIndex !== this.activePageIndex()) return { base: null, overlay: null };
    const base = this.pageCanvases?.get(0)?.nativeElement ?? null;
    const overlay = this.overlayCanvases?.get(0)?.nativeElement ?? null;
    return { base, overlay };
  }

  private async renderActivePage() {
    if (!this.pdfDoc) return;

    const epoch = ++this.renderAllPagesEpoch;
    const pageIndex = clamp(this.activePageIndex(), 0, Math.max(0, this.pageCount() - 1));
    if (epoch !== this.renderAllPagesEpoch) return;
    this.isPageRendering.set(true);
    try {
      await this.renderPage(pageIndex);
      this.redrawOverlay(pageIndex);
    } finally {
      if (epoch === this.renderAllPagesEpoch) this.isPageRendering.set(false);
    }
  }

  private async renderPage(pageIndex: number) {
    if (!this.pdfDoc) return;

    const { base, overlay } = this.getCanvasPair(pageIndex);
    if (!base || !overlay) return;

    const page = await this.pdfDoc.getPage(pageIndex + 1);
    const dpr = window.devicePixelRatio || 1;

    // pdf.js-recommended HiDPI rendering:
    // - Keep `viewport` in CSS pixels (includes page rotation correctly)
    // - Scale the backing store via canvas width/height
    // - Let pdf.js handle DPR scaling through the `transform` option
    const originalRotate = ((page.rotate ?? 0) % 360 + 360) % 360;
    // Some PDFs carry incorrect 180° rotation metadata, which flips pages upside down.
    // We intentionally neutralize ONLY 180° to avoid breaking legitimate 90°/270° landscape pages.
    const rotation = originalRotate === 180 ? 0 : originalRotate;
    this.pageRotateByPage.set(pageIndex, originalRotate);
    const cssViewport = page.getViewport({ scale: this.scale(), rotation });

    base.width = Math.floor(cssViewport.width * dpr);
    base.height = Math.floor(cssViewport.height * dpr);
    base.style.width = `${cssViewport.width}px`;
    base.style.height = `${cssViewport.height}px`;

    overlay.width = Math.floor(cssViewport.width * dpr);
    overlay.height = Math.floor(cssViewport.height * dpr);
    overlay.style.width = `${cssViewport.width}px`;
    overlay.style.height = `${cssViewport.height}px`;

    const ctx = base.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // pdf.js cannot render into the same canvas concurrently.
    // Cancel any in-flight render for this page/canvas before starting a new one.
    const prevTask = this.renderTaskByPage.get(pageIndex);
    if (prevTask?.cancel) {
      try {
        prevTask.cancel();
      } catch {
        // ignore
      }
    }

    const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
    const task = page.render({ canvasContext: ctx, viewport: cssViewport, transform, canvas: base });
    this.renderTaskByPage.set(pageIndex, task);
    try {
      await task.promise;
    } finally {
      if (this.renderTaskByPage.get(pageIndex) === task) {
        this.renderTaskByPage.delete(pageIndex);
      }
    }

    // Snapshot the freshly rendered base (for scanned-PDF inpainting, we must start from original pixels).
    // Use device-pixel coordinates (putImageData ignores transforms).
    try {
      const rawCtx = base.getContext('2d', { willReadFrequently: true });
      if (rawCtx) {
        const snap = rawCtx.getImageData(0, 0, base.width, base.height);
        this.baseSnapshotByPage.set(pageIndex, snap);
      }
    } catch {
      // ignore
    }

    // Detect existing text runs for click-to-edit.
    if (this.textFeatureEnabled()) {
      try {
        const textContent = await page.getTextContent();
        const styles = (textContent as any).styles ?? {};
        const items: DetectedText[] = [];

        for (const it of textContent.items as any[]) {
          const str = String(it.str ?? '');
          if (!str.trim()) continue;

          const tx = Array.isArray(it.transform) ? it.transform : null;
          if (!tx || tx.length < 6) continue;

          const xPdf = Number(tx[4] ?? 0);
          const yPdf = Number(tx[5] ?? 0);

          const [x, yBottom] = cssViewport.convertToViewportPoint(xPdf, yPdf);

          // Better bbox approximation for hit-testing:
          const w = Math.max(1, Number(it.width ?? 0) * cssViewport.scale);
          const h = Math.max(1, Math.hypot(Number(tx[2] ?? 0), Number(tx[3] ?? 0)) * cssViewport.scale);
          const y = yBottom - h;
          const fontSize = Math.max(6, h);
          const fontName = String(it.fontName ?? '');
          const fontStyle = inferFontStyleFromPdfJsStyle(styles[fontName] ?? { fontName });

          // pdf.js gives bottom-left-ish; we want a top-left-ish box for hit testing.
          items.push({
            x,
            y,
            w,
            h,
            text: str,
            fontSize,
            fontStyle
          });
        }

        this.detectedTextByPage.update((prev) => ({ ...prev, [pageIndex]: items }));
        this.detectedBlocksByPage.update((prev) => ({
          ...prev,
          [pageIndex]: this.groupDetectedTextIntoBlocks(items)
        }));
      } catch {
        // ignore text detection failures (still can annotate)
      }
    } else {
      this.detectedTextByPage.update((prev) => ({ ...prev, [pageIndex]: [] }));
      this.detectedBlocksByPage.update((prev) => ({
        ...prev,
        [pageIndex]: []
      }));
    }

    // Ensure we have viewport metadata for export.
    this.editsByPage.update((prev) => {
      const existing = prev[pageIndex];
      const next: PageEdits = existing
        ? {
            ...existing,
            viewportWidth: cssViewport.width,
            viewportHeight: cssViewport.height,
            images: existing.images ?? [],
            replaces: existing.replaces ?? []
          }
        : {
            viewportWidth: cssViewport.width,
            viewportHeight: cssViewport.height,
            ink: [],
            text: [],
            images: [],
            replaces: []
          };
      return { ...prev, [pageIndex]: next };
    });

    // Paint replacements onto the main PDF canvas so the "base layer" updates visually.
    this.applyReplacesToBase(pageIndex);

    // If thumbnails are missing, kick off generation in the background.
    // (In single-page mode we don't naturally render every page.)
    if (!this.pageThumbUrlByPage()[pageIndex]) {
      void this.generateAllPageThumbnails();
    }
  }

  @HostListener('document:pointerdown', ['$event'])
  protected onDocPointerDown(ev: PointerEvent) {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('.sidebarSlideMenu')) return;
    if (target.closest('.pageMenu')) return;
    if (target.closest('.pageMenuBtn')) return;
    if (target.closest('.widget')) return;
    if (target.closest('.imageCropBar')) return;
    if (target.closest('.textDraft')) return;
    if (this.selectedWidgetId() !== null) this.selectedWidgetId.set(null);
    if (this.openPageMenuIndex() !== null) this.openPageMenuIndex.set(null);
    if (this.sidebarSlideMenuOpenIndex() !== null) this.sidebarSlideMenuOpenIndex.set(null);
    if (this.selectedPlacedImageId() !== null) this.selectedPlacedImageId.set(null);
    if (this.imageCropSession() !== null) this.imageCropSession.set(null);
  }

  @HostListener('document:pointermove', ['$event'])
  protected onDocPointerMove(ev: PointerEvent) {
    const opI = this.activePlacedImageOp;
    if (opI) {
      if (ev.pointerId !== opI.pointerId) return;
      const { overlay } = this.getCanvasPair(opI.pageIndex);
      if (!overlay) return;
      const pt = this.eventToPoint(overlay, ev);
      const rect = overlay.getBoundingClientRect();
      const o = opI.orig;
      const minS = 24;

      if (opI.mode === 'move') {
        const dx = pt.x - opI.startX;
        const dy = pt.y - opI.startY;
        const maxX = Math.max(0, rect.width - o.w);
        const maxY = Math.max(0, rect.height - o.h);
        this.updatePlacedImage(opI.pageIndex, opI.id, (a) => ({
          ...a,
          x: clamp(o.x + dx, 0, maxX),
          y: clamp(o.y + dy, 0, maxY)
        }));
        this.redrawOverlay(opI.pageIndex);
        return;
      }

      const edge = opI.edge;
      if (edge === 'e') {
        const nw = clamp(
          o.w + (pt.x - opI.startX),
          minS,
          Math.max(minS, rect.width - o.x)
        );
        this.updatePlacedImage(opI.pageIndex, opI.id, (a) => ({ ...a, w: nw }));
        this.redrawOverlay(opI.pageIndex);
        return;
      }
      if (edge === 's') {
        const nh = clamp(
          o.h + (pt.y - opI.startY),
          minS,
          Math.max(minS, rect.height - o.y)
        );
        this.updatePlacedImage(opI.pageIndex, opI.id, (a) => ({ ...a, h: nh }));
        this.redrawOverlay(opI.pageIndex);
        return;
      }
      if (edge === 'w') {
        const dx = pt.x - opI.startX;
        const nx = o.x + dx;
        const nw0 = o.w - dx;
        const x = clamp(nx, 0, o.x + o.w - minS);
        const w = clamp(nw0, minS, o.x + o.w - x);
        this.updatePlacedImage(opI.pageIndex, opI.id, (a) => ({ ...a, x, w }));
        this.redrawOverlay(opI.pageIndex);
        return;
      }
      if (edge === 'n') {
        const dy = pt.y - opI.startY;
        const ny = o.y + dy;
        const nh0 = o.h - dy;
        const y = clamp(ny, 0, o.y + o.h - minS);
        const h = clamp(nh0, minS, o.y + o.h - y);
        this.updatePlacedImage(opI.pageIndex, opI.id, (a) => ({ ...a, y, h }));
        this.redrawOverlay(opI.pageIndex);
        return;
      }
      return;
    }

    const op = this.activeWidgetOp;
    if (!op) return;
    if (ev.pointerId !== op.pointerId) return;

    const { overlay } = this.getCanvasPair(op.pageIndex);
    if (!overlay) return;
    const pt = this.eventToPoint(overlay, ev);
    const rect = overlay.getBoundingClientRect();

    if (op.mode === 'move') {
      const dx = pt.x - op.startX;
      const dy = pt.y - op.startY;
      const maxX = Math.max(0, rect.width - op.origW);
      const maxY = Math.max(0, rect.height - op.origH);
      this.updateWidget(op.pageIndex, op.id, (w) => ({
        ...w,
        x: clamp(op.origX + dx, 0, maxX),
        y: clamp(op.origY + dy, 0, maxY)
      }));
      return;
    }

    const o = { x: op.origX, y: op.origY, w: op.origW, h: op.origH };
    const dx = pt.x - op.startX;
    const dy = pt.y - op.startY;
    const minW = 80;
    const minH = 60;
    const edge = op.resizeEdge ?? 'br';

    if (edge === 'br') {
      const maxWb = Math.max(minW, rect.width - o.x);
      const maxHb = Math.max(minH, rect.height - o.y);
      this.updateWidget(op.pageIndex, op.id, (w) => ({
        ...w,
        w: clamp(o.w + dx, minW, maxWb),
        h: clamp(o.h + dy, minH, maxHb)
      }));
      return;
    }

    if (edge === 'e') {
      const nw = clamp(
        o.w + dx,
        minW,
        Math.max(minW, rect.width - o.x)
      );
      this.updateWidget(op.pageIndex, op.id, (w) => ({ ...w, w: nw }));
      return;
    }
    if (edge === 's') {
      const nh = clamp(
        o.h + dy,
        minH,
        Math.max(minH, rect.height - o.y)
      );
      this.updateWidget(op.pageIndex, op.id, (w) => ({ ...w, h: nh }));
      return;
    }
    if (edge === 'w') {
      const nx = o.x + dx;
      const nw0 = o.w - dx;
      const x = clamp(nx, 0, o.x + o.w - minW);
      const ww = clamp(nw0, minW, o.x + o.w - x);
      this.updateWidget(op.pageIndex, op.id, (w) => ({ ...w, x, w: ww }));
      return;
    }
    if (edge === 'n') {
      const ny = o.y + dy;
      const nh0 = o.h - dy;
      const y = clamp(ny, 0, o.y + o.h - minH);
      const hh = clamp(nh0, minH, o.y + o.h - y);
      this.updateWidget(op.pageIndex, op.id, (w) => ({ ...w, y, h: hh }));
      return;
    }
  }

  @HostListener('document:pointerup', ['$event'])
  protected onDocPointerUp(ev: PointerEvent) {
    const opI = this.activePlacedImageOp;
    if (opI) {
      if (ev.pointerId !== opI.pointerId) return;
      this.activePlacedImageOp = null;
      this.redrawOverlay(opI.pageIndex);
      return;
    }
    const op = this.activeWidgetOp;
    if (!op) return;
    if (ev.pointerId !== op.pointerId) return;
    this.activeWidgetOp = null;
  }

  private beginWidgetMove(pageIndex: number, widgetId: string, ev: PointerEvent) {
    const { overlay } = this.getCanvasPair(pageIndex);
    if (!overlay) return;
    const pt = this.eventToPoint(overlay, ev);
    const w = this.getWidget(pageIndex, widgetId);
    if (!w) return;

    (ev.target as HTMLElement | null)?.setPointerCapture?.(ev.pointerId);
    this.activeWidgetOp = {
      pageIndex,
      id: widgetId,
      pointerId: ev.pointerId,
      mode: 'move',
      resizeEdge: null,
      startX: pt.x,
      startY: pt.y,
      origX: w.x,
      origY: w.y,
      origW: w.w,
      origH: w.h
    };
  }

  private getWidget(pageIndex: number, widgetId: string): Widget | null {
    const list = this.widgetsByPage()[pageIndex] ?? [];
    return list.find((w) => w.id === widgetId) ?? null;
  }

  private updateWidget(pageIndex: number, widgetId: string, updater: (w: Widget) => Widget) {
    this.widgetsByPage.update((prev) => {
      const cur = prev[pageIndex] ?? [];
      const idx = cur.findIndex((w) => w.id === widgetId);
      if (idx < 0) return prev;
      const next = cur.slice();
      next[idx] = updater(next[idx]!);
      return { ...prev, [pageIndex]: next };
    });
  }

  protected async addBlankPageAfter(pageIndex: number) {
    await this.mutatePdfPages(
      async (pdf) => {
        const insertAt = clamp(pageIndex + 1, 0, pdf.getPageCount());
        const ref = pdf.getPageCount() > 0 ? pdf.getPage(clamp(pageIndex, 0, pdf.getPageCount() - 1)) : null;
        const size = ref ? ref.getSize() : { width: 595.28, height: 841.89 };
        pdf.insertPage(insertAt, [size.width, size.height]);
      },
      { kind: 'insert', at: pageIndex + 1 }
    );
    this.setActivePage(pageIndex + 1);
  }

  /**
   * Public-ish helpers for page management.
   * (Kept as `protected` so templates/child classes can call them.)
   */
  protected async addPage(afterIndex: number | 'active' | 'last' = 'active') {
    if (!this.pdfBytes) {
      this.errorText.set('PDF not loaded.');
      return;
    }
    if (afterIndex === 'active') return await this.addBlankPageAfter(this.activePageIndex());
    if (afterIndex === 'last') return await this.addBlankPageAfter(Math.max(0, this.pageCount() - 1));
    return await this.addBlankPageAfter(afterIndex);
  }

  protected async removePage(index: number | 'active' = 'active') {
    if (!this.pdfBytes) {
      this.errorText.set('PDF not loaded.');
      return;
    }
    const pageIndex = index === 'active' ? this.activePageIndex() : index;
    return await this.deletePage(pageIndex);
  }

  protected async copyPageAfter(pageIndex: number) {
    await this.mutatePdfPages(
      async (pdf) => {
        const srcIndex = clamp(pageIndex, 0, pdf.getPageCount() - 1);
        const [copied] = await pdf.copyPages(pdf, [srcIndex]);
        pdf.insertPage(srcIndex + 1, copied);
      },
      { kind: 'copy', from: pageIndex, to: pageIndex + 1 }
    );
    this.setActivePage(pageIndex + 1);
  }

  protected async deletePage(pageIndex: number) {
    if (!this.pdfBytes) return;
    const count = this.pageCount();
    if (count <= 1) {
      // Don't allow deleting the last page; it would leave an empty PDF and disable save/export flows.
      this.errorText.set('At least one slide is required');
      return;
    }

    await this.mutatePdfPages(
      async (pdf) => {
        const idx = clamp(pageIndex, 0, pdf.getPageCount() - 1);
        pdf.removePage(idx);
      },
      { kind: 'delete', at: pageIndex }
    );

    // After removing page at pageIndex: keep the same index (previous "next" page), or prior page if last was removed.
    const nextActive = clamp(pageIndex, 0, this.pageCount() - 1);
    this.setActivePage(nextActive);
  }

  protected requestDeleteSlide(pageIndex: number, ev?: Event) {
    ev?.stopPropagation();
    if (this.isLoading() || this.isSaving()) return;
    if (this.pageCount() <= 1) {
      this.showSlideToast('At least one slide is required');
      return;
    }
    this.deleteSlideTargetIndex.set(pageIndex);
    this.deleteSlideModalOpen.set(true);
  }

  protected closeDeleteSlideModal() {
    this.deleteSlideModalOpen.set(false);
    this.deleteSlideTargetIndex.set(null);
  }

  protected async confirmDeleteSlide() {
    const idx = this.deleteSlideTargetIndex();
    this.closeDeleteSlideModal();
    if (idx === null || !this.pdfBytes) return;
    await this.deletePage(idx);
    if (!this.errorText()) {
      this.showSlideToast('Slide deleted');
    }
  }

  /**
   * When a PDF page index is deleted, remap `Record<number, T>` keyed by page index immutably
   * (drop `deletedAt`, shift higher keys down).
   */
  protected reindexKeyedByDeletedPage<T>(prev: Record<number, T>, deletedAt: number): Record<number, T> {
    const next: Record<number, T> = {};
    for (const [k, v] of Object.entries(prev)) {
      const idx = Number(k);
      if (!Number.isFinite(idx) || !v) continue;
      if (idx === deletedAt) continue;
      next[idx > deletedAt ? idx - 1 : idx] = v as T;
    }
    return next;
  }

  /**
   * reorder[newIndex] === old page index placed at UI index newIndex.
   */
  private remapKeyedBySlideReorder<T>(prev: Record<number, T>, reorder: number[]): Record<number, T> {
    const next: Record<number, T> = {};
    for (let newIdx = 0; newIdx < reorder.length; newIdx++) {
      const oldIdx = reorder[newIdx]!;
      const v = prev[oldIdx];
      if (v !== undefined) (next as Record<number, unknown>)[newIdx] = v as unknown;
    }
    return next;
  }

  private slideReorderIndices(from: number, to: number, count: number): number[] | null {
    if (count <= 0) return null;
    const fi = clamp(from, 0, count - 1);
    const ti = clamp(to, 0, count - 1);
    if (fi === ti) return null;
    const order = Array.from({ length: count }, (_, i) => i);
    const [moved] = order.splice(fi, 1);
    order.splice(ti, 0, moved);
    return order;
  }

  private activePageIndexAfterSlideReorder(active: number, reorder: number[]): number {
    for (let ni = 0; ni < reorder.length; ni++) {
      if (reorder[ni] === active) return ni;
    }
    return clamp(active, 0, Math.max(0, reorder.length - 1));
  }

  protected onSlideReorderDragStart(pageIndex: number, ev: DragEvent) {
    if (this.isLoading() || this.isSaving() || this.pageCount() <= 1) {
      ev.preventDefault();
      return;
    }
    try {
      const dt = ev.dataTransfer;
      if (!dt) return;
      dt.setData(PdfEditorComponent.slideDragMime, String(pageIndex));
      dt.setData('text/plain', `slide:${pageIndex}`);
      dt.effectAllowed = 'move';
      this.slideDragFromIndex.set(pageIndex);
      this.slideDropHoverIndex.set(null);
    } catch {
      // ignore
    }
  }

  protected onSlideReorderDragEnd() {
    this.slideDragFromIndex.set(null);
    this.slideDropHoverIndex.set(null);
  }

  protected onSidebarSlideDragOver(ev: DragEvent) {
    try {
      const types = [...(ev.dataTransfer?.types ?? [])];
      const slideDrag =
        this.slideDragFromIndex() !== null || types.includes(PdfEditorComponent.slideDragMime);
      if (!slideDrag) return;
      ev.preventDefault();
      ev.dataTransfer!.dropEffect = 'move';
    } catch {
      // ignore
    }
  }

  protected onSidebarSlideDragEnter(pageIndex: number, ev: DragEvent) {
    try {
      const types = [...(ev.dataTransfer?.types ?? [])];
      const slideDrag =
        this.slideDragFromIndex() !== null || types.includes(PdfEditorComponent.slideDragMime);
      if (!slideDrag) return;
      ev.preventDefault();
      ev.dataTransfer!.dropEffect = 'move';
    } catch {
      return;
    }
    this.slideDropHoverIndex.set(pageIndex);
  }

  protected onSidebarSlideDragLeave(pageIndex: number, ev: DragEvent) {
    const cur = ev.currentTarget as HTMLElement | null;
    const rel = ev.relatedTarget as Node | null;
    if (cur && rel && cur.contains(rel)) return;
    if (this.slideDropHoverIndex() === pageIndex) {
      this.slideDropHoverIndex.set(null);
    }
  }

  protected async onSidebarSlideDrop(targetIndex: number, ev: DragEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    const mimeRaw = (ev.dataTransfer?.getData(PdfEditorComponent.slideDragMime) ?? '').trim();
    let fromIx: number | null = null;
    if (mimeRaw !== '') {
      const n = Number(mimeRaw);
      if (Number.isFinite(n)) fromIx = n;
    }
    if (fromIx === null) {
      const t = (ev.dataTransfer?.getData('text/plain') ?? '').trim();
      const m = /^slide:(\d+)$/.exec(t);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n)) fromIx = n;
      }
    }
    if (fromIx === null) {
      const s = this.slideDragFromIndex();
      if (s !== null && Number.isFinite(s)) fromIx = s;
    }
    this.slideDropHoverIndex.set(null);
    this.slideDragFromIndex.set(null);
    if (fromIx === null) return;
    await this.reorderSlidesInDocument(fromIx, targetIndex);
  }

  /**
   * Reorder PDF pages and remap per-page edits/widgets/rotation maps.
   */
  private async reorderSlidesInDocument(fromIndex: number, toIndex: number) {
    if (!this.pdfBytes) return;
    if (this.isLoading() || this.isSaving()) return;
    const count = this.pageCount();
    const reorder = this.slideReorderIndices(fromIndex, toIndex, count);
    if (!reorder) return;

    const prevActive = this.activePageIndex();
    this.errorText.set(null);
    this.openPageMenuIndex.set(null);
    this.sidebarSlideMenuOpenIndex.set(null);
    this.isLoading.set(true);

    try {
      this.assertReadablePdfHeader(this.pdfBytes);
      const srcPdf = await PDFDocument.load(this.clonePdfBytes(this.pdfBytes));
      const outPdf = await PDFDocument.create();
      const copied = await outPdf.copyPages(srcPdf, reorder);
      for (const p of copied) {
        outPdf.addPage(p);
      }
      const out = await outPdf.save();
      const nextBytes =
        out instanceof Uint8Array ? new Uint8Array(out) : new Uint8Array(out as any);
      const header =
        nextBytes.byteLength >= 5
          ? String.fromCharCode(
              nextBytes[0]!,
              nextBytes[1]!,
              nextBytes[2]!,
              nextBytes[3]!,
              nextBytes[4]!
            )
          : '';
      if (!header.startsWith('%PDF-')) {
        throw new Error('Failed to reorder PDF (invalid PDF output).');
      }
      this.pdfBytes = nextBytes;
      await this.persistPdfBytesToBackend();

      this.editsByPage.set(this.remapKeyedBySlideReorder(this.editsByPage(), reorder));
      this.widgetsByPage.set(this.remapKeyedBySlideReorder(this.widgetsByPage(), reorder));

      const nextRot = new Map<number, number>();
      for (let newIdx = 0; newIdx < reorder.length; newIdx++) {
        const oldIdx = reorder[newIdx]!;
        const rot = this.pageRotateByPage.get(oldIdx);
        if (rot !== undefined) nextRot.set(newIdx, rot);
      }
      this.pageRotateByPage.clear();
      for (const [k, v] of nextRot) {
        this.pageRotateByPage.set(k, v);
      }

      this.pageThumbUrlByPage.set({});
      this.detectedTextByPage.set({});
      this.detectedBlocksByPage.set({});
      this.baseSnapshotByPage.clear();
      this.renderTaskByPage.clear();
      this.resetHistory();

      this.activePageIndex.set(this.activePageIndexAfterSlideReorder(prevActive, reorder));

      try {
        await this.pdfDoc?.destroy();
      } catch {
        // ignore
      }

      const buf = nextBytes.buffer.slice(nextBytes.byteOffset, nextBytes.byteOffset + nextBytes.byteLength);
      const loadingTask = getDocument({
        data: buf,
        disableRange: true,
        disableStream: true,
        disableAutoFetch: true
      });
      const doc = await loadingTask.promise;
      this.pdfDoc = doc;
      this.pageCount.set(doc.numPages);
      await this.renderActivePage();
      void this.generateAllPageThumbnails();
      this.showSlideToast('Slides reordered');
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to reorder slides.');
    } finally {
      this.isLoading.set(false);
    }
  }

  private showSlideToast(message: string) {
    if (this.slideToastClearTimer !== null) {
      clearTimeout(this.slideToastClearTimer);
      this.slideToastClearTimer = null;
    }
    this.slideToast.set(message);
    this.slideToastClearTimer = setTimeout(() => {
      this.slideToast.set(null);
      this.slideToastClearTimer = null;
    }, 3200);
  }

  private remapEditsAfterInsert(atIndex: number) {
    const prev = this.editsByPage();
    const next: Record<number, PageEdits> = {};
    for (const [k, v] of Object.entries(prev)) {
      const idx = Number(k);
      if (!Number.isFinite(idx) || !v) continue;
      next[idx >= atIndex ? idx + 1 : idx] = v;
    }
    this.editsByPage.set(next);
  }

  private remapEditsAfterDelete(atIndex: number) {
    this.editsByPage.set(this.reindexKeyedByDeletedPage(this.editsByPage(), atIndex));
  }

  private remapEditsAfterCopy(fromIndex: number, toIndex: number) {
    const prev = this.editsByPage();
    const next: Record<number, PageEdits> = {};
    for (const [k, v] of Object.entries(prev)) {
      const idx = Number(k);
      if (!Number.isFinite(idx) || !v) continue;
      next[idx >= toIndex ? idx + 1 : idx] = v;
    }
    const copied = prev[fromIndex];
    if (copied) next[toIndex] = this.cloneEdits({ 0: copied })[0]!;
    this.editsByPage.set(next);
  }

  private async mutatePdfPages(
    mutate: (pdf: PDFDocument) => void | Promise<void>,
    remap:
      | { kind: 'insert'; at: number }
      | { kind: 'delete'; at: number }
      | { kind: 'copy'; from: number; to: number }
  ) {
    if (!this.pdfBytes) return;
    this.errorText.set(null);
    this.isLoading.set(true);
    this.openPageMenuIndex.set(null);
    this.sidebarSlideMenuOpenIndex.set(null);

    try {
      this.assertReadablePdfHeader(this.pdfBytes);
      // pdf.lib should always load from a clean copy; avoid any detached/aliased buffer edge cases.
      const pdf = await PDFDocument.load(this.clonePdfBytes(this.pdfBytes));
      await mutate(pdf);
      const out = await pdf.save();
      const nextBytes = out instanceof Uint8Array ? new Uint8Array(out) : new Uint8Array(out as any);
      const header =
        nextBytes.byteLength >= 5
          ? String.fromCharCode(nextBytes[0]!, nextBytes[1]!, nextBytes[2]!, nextBytes[3]!, nextBytes[4]!)
          : '';
      if (!header.startsWith('%PDF-')) {
        throw new Error('Failed to update PDF pages (invalid PDF output).');
      }
      this.pdfBytes = nextBytes;
      await this.persistPdfBytesToBackend();

      if (remap.kind === 'insert') this.remapEditsAfterInsert(remap.at);
      if (remap.kind === 'delete') {
        this.remapEditsAfterDelete(remap.at);
        this.widgetsByPage.set(this.reindexKeyedByDeletedPage(this.widgetsByPage(), remap.at));
      }
      if (remap.kind === 'copy') this.remapEditsAfterCopy(remap.from, remap.to);

      this.pageThumbUrlByPage.set({});
      this.detectedTextByPage.set({});
      this.detectedBlocksByPage.set({});
      this.baseSnapshotByPage.clear();
      this.pageRotateByPage.clear();
      this.renderTaskByPage.clear();
      this.resetHistory();

      try {
        await this.pdfDoc?.destroy();
      } catch {
        // ignore
      }
      // pdf.js can be finicky with typed-array views / streaming options.
      // Hand it a tight ArrayBuffer and disable range/stream fetching.
      const buf = nextBytes.buffer.slice(nextBytes.byteOffset, nextBytes.byteOffset + nextBytes.byteLength);
      const loadingTask = getDocument({
        data: buf,
        disableRange: true,
        disableStream: true,
        disableAutoFetch: true
      });
      const doc = await loadingTask.promise;
      this.pdfDoc = doc;
      this.pageCount.set(doc.numPages);
      // Re-render immediately so editing continues to work without needing a full refresh.
      await this.renderActivePage();
      void this.generateAllPageThumbnails();
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to update PDF pages.');
    } finally {
      this.isLoading.set(false);
    }
  }

  private async generateAllPageThumbnails() {
    if (!this.pdfDoc) return;
    const epoch = ++this.thumbsEpoch;
    const count = this.pageCount();
    if (count <= 0) return;

    // Generate thumbnails in the background; keep them small to avoid memory bloat.
    // We use a separate offscreen canvas per page.
    for (let pageIndex = 0; pageIndex < count; pageIndex++) {
      if (epoch !== this.thumbsEpoch) return;
      if (this.pageThumbUrlByPage()[pageIndex]) continue;
      try {
        const page = await this.pdfDoc.getPage(pageIndex + 1);
        const rotation = (((page.rotate ?? 0) % 360) + 360) % 360;
        const viewport = page.getViewport({ scale: 0.18, rotation: rotation === 180 ? 0 : rotation });
        const canvas = document.createElement('canvas');
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
        await page.render({ canvasContext: ctx, viewport, transform, canvas }).promise;
        const url = canvas.toDataURL('image/jpeg', 0.6);
        if (epoch !== this.thumbsEpoch) return;
        this.pageThumbUrlByPage.update((prev) => ({ ...prev, [pageIndex]: url }));
      } catch {
        // ignore thumbnail failures (page still usable)
      }
    }
  }

  private restoreBaseFromSnapshot(pageIndex: number) {
    const { base } = this.getCanvasPair(pageIndex);
    if (!base) return;
    const snap = this.baseSnapshotByPage.get(pageIndex);
    if (!snap) return;
    const ctx = base.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(snap, 0, 0);
  }

  protected onOverlayPointerDown(pageIndex: number, ev: PointerEvent) {
    const pending = this.insertWidgetPending();
    if (pending) {
      if (pending.kind === 'image' && !pending.imageDataUrl) return;
      if (pending.kind === 'video' && !pending.videoObjectUrl) return;

      const { overlay } = this.getCanvasPair(pageIndex);
      if (!overlay) return;
      const p = this.eventToPoint(overlay, ev);
      this.addWidgetAtPoint(pageIndex, pending.kind, p.x, p.y, {
        imageDataUrl: pending.imageDataUrl,
        videoObjectUrl: pending.videoObjectUrl
      });
      this.insertWidgetPending.set(null);
      this.isInserting.set(false);
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }

    if (this.tool() !== 'pen' && !(this.tool() === 'image' && this.pendingImageDataUrl)) {
      const { overlay } = this.getCanvasPair(pageIndex);
      if (overlay) {
        const p = this.eventToPoint(overlay, ev);
        const hit = this.hitTestPlacedImage(pageIndex, p.x, p.y);
        if (hit) {
          const anno = this.getImageAnno(pageIndex, hit.id);
          if (!anno) {
            ev.preventDefault();
            ev.stopPropagation();
            return;
          }
          this.selectedWidgetId.set(null);
          this.beginHistoryStep();
          this.selectedPlacedImageId.set(hit.id);
          (ev.currentTarget as HTMLCanvasElement | null)?.setPointerCapture?.(ev.pointerId);
          this.activePlacedImageOp = {
            pageIndex,
            id: hit.id,
            pointerId: ev.pointerId,
            mode: hit.part === 'body' ? 'move' : 'resize',
            edge: hit.part === 'body' ? null : hit.part,
            startX: p.x,
            startY: p.y,
            orig: { x: anno.x, y: anno.y, w: anno.w, h: anno.h }
          };
          ev.preventDefault();
          ev.stopPropagation();
          this.redrawOverlay(pageIndex);
          return;
        }
        this.selectedPlacedImageId.set(null);
        this.imageCropSession.set(null);
        this.redrawOverlay(pageIndex);
      }
    }

    if (this.tool() === 'pen') {
      const { overlay } = this.getCanvasPair(pageIndex);
      if (!overlay) return;

      overlay.setPointerCapture(ev.pointerId);
      const p = this.eventToPoint(overlay, ev);
      const stroke: InkStroke = {
        color: this.penColor(),
        width: this.penWidth(),
        points: [p]
      };

      this.activeInk = { pageIndex, stroke, pointerId: ev.pointerId, lastPoint: p };
      this.pushInkStroke(pageIndex, stroke);
      this.redrawOverlay(pageIndex);
      return;
    }

    if (this.tool() === 'text' && this.textFeatureEnabled()) {
      const { overlay } = this.getCanvasPair(pageIndex);
      if (!overlay) return;
      const p = this.eventToPoint(overlay, ev);

      if (this.editExistingText()) {
        const hitReplace = this.hitTestExistingReplace(pageIndex, p.x, p.y);
        if (hitReplace) {
          const { r, idx } = hitReplace;
          this.editingReplace = { pageIndex, idx };
          this.isTextPlacing.set(true);
          this.textDraft.set(r.newText);
          this.textDraftPageIndex.set(pageIndex);
          this.textDraftX.set(r.x);
          this.textDraftY.set(r.y);
          // Sync toolbar with selected replace.
          this.textColor.set(r.color);
          this.textSize.set(Math.round(r.fontSize));
          this.textStyle.set(r.fontStyle);
          this.textFamily.set(r.fontFamily ?? 'helvetica');
          this.textBgEnabled.set(true);
          this.textBgColor.set(r.bgColor);
          this.textDraftBox = {
            w: r.w,
            h: r.h,
            oldText: r.newText,
            bgColor: r.bgColor,
            color: r.color,
            maskMode: r.maskMode,
            fontSize: r.fontSize,
            fontStyle: r.fontStyle,
            fontFamily: r.fontFamily ?? 'helvetica'
          };
          // While editing, mask the old content on the overlay so the textarea
          // sits on a clean (white) region.
          this.redrawOverlay(pageIndex);
          return;
        }

        const hit = this.hitTestDetectedBlock(pageIndex, p.x, p.y);
        if (hit) {
          this.editingReplace = null;
          const { fg } = this.sampleTextAndBgColors(pageIndex, hit);
          // For a clean edit experience, always mask with solid white.
          // (Inpainting can leave ghosting/overrides depending on nearby pixels.)
          const bg = '#ffffff';
          this.isTextPlacing.set(true);
          this.textDraft.set(hit.text);
          this.textDraftPageIndex.set(pageIndex);
          // Pad mask bbox to fully cover anti-aliased glyph edges.
          const pad = 6;
          this.textDraftX.set(Math.max(0, hit.x - pad));
          this.textDraftY.set(Math.max(0, hit.y - pad));
          const hitFontSize = Math.round(hit.fontSize);
          this.textSize.set(hitFontSize);
          // Start from the original look instead of switching colors.
          this.textColor.set(fg);
          // Preserve detected font style (bold/italic) so edits don't change formatting.
          this.textStyle.set(hit.fontStyle);
          // Family is not reliably detectable from pdf.js; keep current selection.
          this.textBgEnabled.set(true);
          this.textBgColor.set(bg);
          this.textDraftBox = {
            w: hit.w + pad * 2,
            h: hit.h + pad * 2,
            oldText: hit.text,
            bgColor: bg,
            color: fg,
            maskMode: 'color',
            fontSize: hitFontSize,
            fontStyle: hit.fontStyle,
            fontFamily: this.textFamily()
          };
          // While editing, mask the old content on the overlay so the textarea
          // sits on a clean (white) region.
          this.redrawOverlay(pageIndex);
          return;
        }
      }

      // New text
      this.editingReplace = null;
      this.isTextPlacing.set(true);
      this.textDraft.set('');
      this.textDraftPageIndex.set(pageIndex);
      this.textDraftX.set(p.x);
      this.textDraftY.set(p.y);
      // New text defaults to no background fill.
      this.textBgEnabled.set(false);
      this.textDraftBox = null;
      this.redrawOverlay(pageIndex);
    }

    if (this.tool() === 'image') {
      if (!this.pendingImageDataUrl) {
        this.errorText.set('Pick an image first.');
        return;
      }

      const { overlay } = this.getCanvasPair(pageIndex);
      if (!overlay) return;
      const p = this.eventToPoint(overlay, ev);
      void this.placePendingImage(pageIndex, p.x, p.y);
      ev.stopPropagation();
    }
  }

  protected onOverlayPointerMove(pageIndex: number, ev: PointerEvent) {
    if (!this.activeInk) return;
    if (this.activeInk.pageIndex !== pageIndex) return;
    if (this.activeInk.pointerId !== ev.pointerId) return;

    const { overlay } = this.getCanvasPair(pageIndex);
    if (!overlay) return;

    const p = this.eventToPoint(overlay, ev);
    const stroke = this.activeInk.stroke;
    const last = this.activeInk.lastPoint;

    // Avoid storing too many points (keeps export fast).
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1) return;

    stroke.points.push(p);
    this.activeInk.lastPoint = p;
    this.redrawOverlay(pageIndex);
  }

  protected onOverlayPointerUp(pageIndex: number, ev: PointerEvent) {
    if (!this.activeInk) return;
    if (this.activeInk.pageIndex !== pageIndex) return;
    if (this.activeInk.pointerId !== ev.pointerId) return;

    this.activeInk = null;
    this.redrawOverlay(pageIndex);
  }

  protected commitTextDraft() {
    if (!this.textFeatureEnabled()) {
      this.cancelTextDraft();
      return;
    }
    const pageIndex = this.textDraftPageIndex();
    if (pageIndex === null) return;

    // Keep the exact user input; don't trim, otherwise blur/commit can
    // unintentionally change content and create a mask patch.
    const text = this.textDraft();

    // If we are editing existing text, allow empty newText (acts like delete):
    // we still create the replacement rectangle to cover the original glyphs.
    if (this.textDraftBox) {
      // If user didn't change anything, don't create a replacement (avoids flashing/white patches).
      if (text === this.textDraftBox.oldText) {
        this.isTextPlacing.set(false);
        this.textDraft.set('');
        this.textDraftPageIndex.set(null);
        this.textDraftBox = null;
        this.editingReplace = null;
        this.redrawOverlay(pageIndex);
        return;
      }

      const r: TextReplace = {
        x: this.textDraftX(),
        y: this.textDraftY(),
        w: this.textDraftBox.w,
        h: this.textDraftBox.h,
        oldText: this.textDraftBox.oldText,
        newText: text,
        maskMode: this.textDraftBox.maskMode,
        bgColor: this.textBgColor(),
        color: this.textColor(),
        fontSize: this.textSize(),
        fontStyle: this.textStyle(),
        fontFamily: this.textFamily()
      };
      if (this.editingReplace && this.editingReplace.pageIndex === pageIndex) {
        this.updateTextReplace(pageIndex, this.editingReplace.idx, r);
      } else {
        this.pushTextReplace(pageIndex, r);
      }
      this.redrawOverlay(pageIndex);
      this.applyReplacesToBase(pageIndex);
    } else if (text.trim().length > 0) {
      // New text: ignore empty
      const anno: TextAnno = {
        x: this.textDraftX(),
        y: this.textDraftY(),
        text: text.trim(),
        color: this.textColor(),
        fontSize: this.textSize(),
        fontStyle: this.textStyle(),
        fontFamily: this.textFamily(),
        bgColor: this.textBgEnabled() ? this.textBgColor() : null
      };
      this.pushTextAnno(pageIndex, anno);
      this.redrawOverlay(pageIndex);
    }

    this.isTextPlacing.set(false);
    this.textDraft.set('');
    this.textDraftPageIndex.set(null);
    this.textDraftBox = null;
    this.editingReplace = null;
    this.redrawOverlay(pageIndex);
  }

  protected onToolbarPointerDown(_ev: PointerEvent) {
    // Clicking toolbar controls blurs the textarea; we want to keep the current
    // text selection active while the user tweaks styling.
    this.suppressCommitOnBlurOnce = true;
    queueMicrotask(() => {
      this.suppressCommitOnBlurOnce = false;
    });
  }

  protected onTextDraftBlur(ev: FocusEvent) {
    if (this.suppressCommitOnBlurOnce) return;
    const next = (ev.relatedTarget ?? null) as HTMLElement | null;
    if (next?.closest?.('.toolbar')) return;
    this.commitTextDraft();
  }

  protected cancelTextDraft() {
    const pageIndex = this.textDraftPageIndex();
    this.isTextPlacing.set(false);
    this.textDraft.set('');
    this.textDraftPageIndex.set(null);
    this.textDraftBox = null;
    this.editingReplace = null;
    if (pageIndex !== null) this.redrawOverlay(pageIndex);
  }

  /**
   * In-page text editor style.
   * - When editing existing detected text, match the detected box width/height.
   * - When adding new text, use a compact default (like yesterday).
   */
  protected textDraftStyle() {
    const pageIndex = this.textDraftPageIndex();
    if (pageIndex === null) return {};
    const box = this.textDraftBox;
    const w = box ? Math.max(160, Math.round(box.w)) : 320;
    const h = box ? Math.max(44, Math.round(box.h)) : 44;
    const fontStyle = this.textStyle();
    const style = fontStyle.includes('italic') ? 'italic' : 'normal';
    const weight = fontStyle.includes('bold') ? '700' : '400';

    return {
      left: `${this.textDraftX()}px`,
      top: `${this.textDraftY()}px`,
      width: `${w}px`,
      height: `${h}px`,
      color: this.textColor(),
      background: this.textBgEnabled() ? this.textBgColor() : 'transparent',
      fontSize: `${this.textSize()}px`,
      fontStyle: style,
      fontWeight: weight,
      fontFamily: cssFontFamily(this.textFamily()),
      lineHeight: '1.2',
      zIndex: 7
    };
  }

  private pushInkStroke(pageIndex: number, stroke: InkStroke) {
    this.beginHistoryStep();
    this.editsByPage.update((prev) => {
      const existing = prev[pageIndex] ?? {
        viewportWidth: 1,
        viewportHeight: 1,
        ink: [],
        text: [],
        images: [],
        replaces: []
      };
      return {
        ...prev,
        [pageIndex]: { ...existing, ink: [...existing.ink, stroke] }
      };
    });
  }

  private pushTextAnno(pageIndex: number, anno: TextAnno) {
    this.beginHistoryStep();
    this.editsByPage.update((prev) => {
      const existing = prev[pageIndex] ?? {
        viewportWidth: 1,
        viewportHeight: 1,
        ink: [],
        text: [],
        images: [],
        replaces: []
      };
      return {
        ...prev,
        [pageIndex]: { ...existing, text: [...existing.text, anno] }
      };
    });
  }

  protected readonly textWeight = computed(() => weightFromStyle(this.textStyle()));

  protected setTextWeight(weight: 400 | 700) {
    this.textStyle.set(styleWithWeight(this.textStyle(), weight));
  }

  protected setTextFamily(family: FontFamily) {
    this.textFamily.set(family);
    // Some PDFs expose subset font names like "ABCDEE+Helvetica-Bold".
    // Treat it as Helvetica with bold weight.
    if (family === 'abcdee_helvetica_bold') {
      this.textStyle.set(styleWithWeight(this.textStyle(), 700));
    }
  }

  private pushTextReplace(pageIndex: number, rep: TextReplace) {
    this.beginHistoryStep();
    this.editsByPage.update((prev) => {
      const existing = prev[pageIndex] ?? {
        viewportWidth: 1,
        viewportHeight: 1,
        ink: [],
        text: [],
        images: [],
        replaces: []
      };
      return {
        ...prev,
        [pageIndex]: { ...existing, replaces: [...existing.replaces, rep] }
      };
    });
  }

  private updateTextReplace(pageIndex: number, idx: number, rep: TextReplace) {
    this.beginHistoryStep();
    this.editsByPage.update((prev) => {
      const existing = prev[pageIndex];
      if (!existing) return prev;
      const replaces = [...existing.replaces];
      if (idx < 0 || idx >= replaces.length) return prev;
      // Preserve original oldText for export/masking purposes.
      replaces[idx] = { ...replaces[idx]!, ...rep, oldText: replaces[idx]!.oldText };
      return { ...prev, [pageIndex]: { ...existing, replaces } };
    });
  }

  private hitTestExistingReplace(pageIndex: number, x: number, y: number): { r: TextReplace; idx: number } | null {
    const replaces = this.editsByPage()[pageIndex]?.replaces ?? [];
    for (let i = replaces.length - 1; i >= 0; i--) {
      const r = replaces[i]!;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return { r, idx: i };
    }
    return null;
  }

  private pushImageAnno(pageIndex: number, anno: ImageAnno) {
    this.beginHistoryStep();
    this.editsByPage.update((prev) => {
      const existing = prev[pageIndex] ?? {
        viewportWidth: 1,
        viewportHeight: 1,
        ink: [],
        text: [],
        images: [],
        replaces: []
      };
      return {
        ...prev,
        [pageIndex]: { ...existing, images: [...existing.images, anno] }
      };
    });
  }

  private newPlacedImageId(): string {
    return `img_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  }

  private getImageAnno(pageIndex: number, id: string): ImageAnno | null {
    return this.editsByPage()[pageIndex]?.images?.find((a) => a.id === id) ?? null;
  }

  private updatePlacedImage(pageIndex: number, id: string, updater: (a: ImageAnno) => ImageAnno) {
    this.editsByPage.update((prev) => {
      const ex = prev[pageIndex];
      if (!ex) return prev;
      const images = (ex.images ?? []).map((im) => (im.id === id ? updater(im) : im));
      return { ...prev, [pageIndex]: { ...ex, images } };
    });
  }

  private getSourceRectForPlaced(anno: ImageAnno, el: HTMLImageElement) {
    const natW = el.naturalWidth;
    const natH = el.naturalHeight;
    if (anno.crop) {
      return { sx: anno.crop.x, sy: anno.crop.y, sw: anno.crop.w, sh: anno.crop.h, natW, natH };
    }
    const sw = (anno as any).srcW > 0 ? (anno as any).srcW : natW;
    const sh = (anno as any).srcH > 0 ? (anno as any).srcH : natH;
    return { sx: 0, sy: 0, sw, sh, natW, natH };
  }

  private hitTestPlacedImage(
    pageIndex: number,
    x: number,
    y: number
  ): { id: string; part: 'body' | PlacedImageEdge } | null {
    const images = this.editsByPage()[pageIndex]?.images ?? [];
    const hsz = PdfEditorComponent.placedImageHandleHit;
    for (let i = images.length - 1; i >= 0; i--) {
      const im = images[i]!;
      const { x: ix, y: iy, w: iw, h: ih } = im;
      if (Math.hypot(x - (ix + iw / 2), y - iy) <= hsz) return { id: im.id, part: 'n' };
      if (Math.hypot(x - (ix + iw / 2), y - (iy + ih)) <= hsz) return { id: im.id, part: 's' };
      if (Math.hypot(x - (ix + iw), y - (iy + ih / 2)) <= hsz) return { id: im.id, part: 'e' };
      if (Math.hypot(x - ix, y - (iy + ih / 2)) <= hsz) return { id: im.id, part: 'w' };
      if (x >= ix && x <= ix + iw && y >= iy && y <= iy + ih) return { id: im.id, part: 'body' };
    }
    return null;
  }

  private drawPlacedImageChrome(ctx: CanvasRenderingContext2D, anno: ImageAnno) {
    if (this.selectedPlacedImageId() !== anno.id) return;
    const hs = PdfEditorComponent.placedImageHandlePx;
    const { x, y, w, h: hh } = anno;
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.95)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x, y, w, hh);
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.9)';

    const drawHandle = (ax: number, ay: number) => {
      ctx.beginPath();
      ctx.rect(ax - hs / 2, ay - hs / 2, hs, hs);
      ctx.fill();
      ctx.stroke();
    };
    drawHandle(x + w / 2, y);
    drawHandle(x + w / 2, y + hh);
    drawHandle(x + w, y + hh / 2);
    drawHandle(x, y + hh / 2);
  }

  private redrawAllOverlays() {
    for (let pageIndex = 0; pageIndex < this.pageCount(); pageIndex++) {
      this.redrawOverlay(pageIndex);
    }
  }

  private redrawOverlay(pageIndex: number) {
    const { overlay } = this.getCanvasPair(pageIndex);
    if (!overlay) return;

    const ctx = overlay.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = overlay.width / dpr;
    const h = overlay.height / dpr;
    ctx.clearRect(0, 0, w, h);

    // If we're editing existing text, temporarily cover the old region on the overlay.
    // This uses "white" intentionally (requested behavior) so underlying content doesn't show through.
    if (this.isTextPlacing() && this.textDraftPageIndex() === pageIndex && this.textDraftBox) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(this.textDraftX(), this.textDraftY(), this.textDraftBox.w, this.textDraftBox.h);
    }

    const edit = this.editsByPage()[pageIndex];
    if (!edit) return;

    // Images (before ink + text; selection chrome drawn on top of everything below)
    for (const img of edit.images) {
      const image = new Image();
      image.src = img.dataUrl;
      const paint = () => {
        const { sx, sy, sw, sh } = this.getSourceRectForPlaced(img, image);
        ctx.drawImage(image, sx, sy, sw, sh, img.x, img.y, img.w, img.h);
      };
      if (image.complete) {
        paint();
      } else {
        image.onload = () => {
          this.redrawOverlay(pageIndex);
        };
      }
    }

    // Ink
    for (const stroke of edit.ink) {
      if (stroke.points.length < 2) continue;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    // Text (preview)
    for (const t of edit.text) {
      const style = t.fontStyle.includes('italic') ? 'italic' : 'normal';
      const weight = t.fontStyle.includes('bold') ? '700' : '400';
      ctx.textBaseline = 'top';
      ctx.font = `${style} ${weight} ${t.fontSize}px ${cssFontFamily(t.fontFamily ?? 'helvetica')}`;

      const lines = t.text.split('\n');
      const lh = Math.max(1, Math.round(t.fontSize * 1.2));
      if (t.bgColor) {
        ctx.fillStyle = t.bgColor;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          const w = ctx.measureText(line).width;
          ctx.fillRect(t.x, t.y + i * lh, w, lh);
        }
      }

      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }

    for (const img of edit.images) {
      this.drawPlacedImageChrome(ctx, img);
    }
  }

  private applyReplacesToBase(pageIndex: number) {
    const { base } = this.getCanvasPair(pageIndex);
    if (!base) return;
    const edit = this.editsByPage()[pageIndex];
    if (!edit || edit.replaces.length === 0) return;

    const ctx = base.getContext('2d');
    if (!ctx) return;

    // Restore pristine render before applying all replaces (prevents cumulative artifacts).
    const snap = this.baseSnapshotByPage.get(pageIndex);
    if (snap) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.putImageData(snap, 0, 0);
    }

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (const r of edit.replaces) {
      if (r.maskMode === 'inpaint') {
        // Opaque erase first (prevents ghosting of previous glyphs),
        // then inpaint texture from nearby pixels.
        ctx.fillStyle = r.bgColor;
        ctx.fillRect(r.x, r.y, r.w, r.h);
        const dpr = window.devicePixelRatio || 1;
        this.inpaintRect(ctx, base, r.x, r.y, r.w, r.h, dpr);
      } else {
        ctx.fillStyle = r.bgColor;
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }

      if (r.newText.length > 0) {
        ctx.fillStyle = r.color;
        const style = r.fontStyle.includes('italic') ? 'italic' : 'normal';
        const weight = r.fontStyle.includes('bold') ? '700' : '400';
        ctx.font = `${style} ${weight} ${r.fontSize}px ${cssFontFamily(r.fontFamily ?? 'helvetica')}`;
        ctx.textBaseline = 'top';
        const lines = r.newText.split('\n');
        const lh = Math.max(1, Math.round(r.fontSize * 1.2));
        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], r.x, r.y + i * lh);
        }
      }
    }
  }

  private eventToPoint(canvas: HTMLCanvasElement, ev: PointerEvent): InkPoint {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    return { x: clamp(x, 0, rect.width), y: clamp(y, 0, rect.height) };
  }

  private hitTestDetectedText(pageIndex: number, x: number, y: number): DetectedText | null {
    const items = this.detectedTextByPage()[pageIndex] ?? [];
    // iterate in reverse (later items tend to be "on top")
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) return it;
    }
    return null;
  }

  private hitTestDetectedBlock(pageIndex: number, x: number, y: number): DetectedBlock | null {
    const blocks = this.detectedBlocksByPage()[pageIndex] ?? [];
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
    }
    return null;
  }

  private groupDetectedTextIntoBlocks(items: DetectedText[]): DetectedBlock[] {
    if (items.length === 0) return [];

    // Sort top-to-bottom, then left-to-right.
    const sorted = [...items].sort((a, b) => (a.y - b.y) || (a.x - b.x));

    const fontSizes = sorted.map((s) => s.fontSize).sort((a, b) => a - b);
    const medianFont = fontSizes[Math.floor(fontSizes.length / 2)] ?? 12;

    const yTol = Math.max(4, medianFont * 0.6);
    const lines: {
      spans: DetectedText[];
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      fontSize: number;
      fontStyle: FontStyle;
      text: string;
    }[] = [];

    // Build lines by clustering spans with similar vertical centers.
    for (const s of sorted) {
      const sCy = s.y + s.h * 0.5;
      let bestIdx = -1;
      let bestDy = Infinity;

      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i];
        const lnCy = ln.y0 + (ln.y1 - ln.y0) * 0.5;
        const dy = Math.abs(sCy - lnCy);
        if (dy < bestDy) {
          bestDy = dy;
          bestIdx = i;
        }
        if (s.y - ln.y1 > yTol * 2) break;
      }

      if (bestIdx >= 0 && bestDy <= yTol) {
        lines[bestIdx].spans.push(s);
      } else {
        lines.push({
          spans: [s],
          x0: s.x,
          y0: s.y,
          x1: s.x + s.w,
          y1: s.y + s.h,
          fontSize: s.fontSize,
          fontStyle: s.fontStyle,
          text: ''
        });
      }
    }

    // Finalize each line: bbox + joined text.
    const finalizedLines: typeof lines = [];
    for (const ln of lines) {
      ln.spans.sort((a, b) => a.x - b.x);

      // Split a single pdf.js "line" into multiple segments when there are large horizontal gaps.
      // This avoids merging UI-like grids (e.g. separate labels in separate boxes) into one huge edit block.
      const segments: DetectedText[][] = [];
      let curSeg: DetectedText[] = [];
      let prevRight = -Infinity;
      for (const sp of ln.spans) {
        const gap = sp.x - prevRight;
        const splitGap = Math.max(18, sp.fontSize * 2.0);
        if (curSeg.length > 0 && gap > splitGap) {
          segments.push(curSeg);
          curSeg = [];
        }
        curSeg.push(sp);
        prevRight = sp.x + sp.w;
      }
      if (curSeg.length > 0) segments.push(curSeg);

      for (const seg of segments) {
        let text = '';
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        let maxFs = 0;
        const fs: FontStyle[] = [];
        let prevR = -Infinity;
        for (const sp of seg) {
          x0 = Math.min(x0, sp.x);
          y0 = Math.min(y0, sp.y);
          x1 = Math.max(x1, sp.x + sp.w);
          y1 = Math.max(y1, sp.y + sp.h);
          maxFs = Math.max(maxFs, sp.fontSize);
          fs.push(sp.fontStyle);

          const gap = sp.x - prevR;
          if (text.length > 0 && gap > Math.max(2, sp.fontSize * 0.35)) text += ' ';
          text += sp.text;
          prevR = sp.x + sp.w;
        }

        finalizedLines.push({
          spans: seg,
          x0,
          y0,
          x1,
          y1,
          fontSize: maxFs || medianFont,
          fontStyle: dominantFontStyle(fs),
          text: text.trim()
        });
      }
    }

    // Replace with segmented/finalized lines.
    lines.length = 0;
    lines.push(...finalizedLines);

    // Group lines into blocks (paragraph/list/heading-ish).
    const lineGapTol = Math.max(6, medianFont * 1.15);
    const indentTol = Math.max(10, medianFont * 0.9);

    const blocks: DetectedBlock[] = [];
    let cur:
      | { lines: typeof lines; x0: number; y0: number; x1: number; y1: number; fontSize: number }
      | null = null;

    const pushCur = () => {
      if (!cur || cur.lines.length === 0) return;
      const allText = cur.lines
        .map((l) => l.text)
        .filter(Boolean)
        .join('\n');
      const firstText = cur.lines[0]?.text ?? '';
      const isList = /^(\s*([-•]|(\d+)[.)]))\s+/.test(firstText);
      const isHeading = cur.fontSize >= medianFont * 1.25 && allText.length <= 120;
      const kind: DetectedBlockKind = isHeading ? 'heading' : isList ? 'list' : 'paragraph';
      const blockStyle = dominantFontStyle(cur.lines.map((l) => l.fontStyle));
      blocks.push({
        x: cur.x0,
        y: cur.y0,
        w: Math.max(1, cur.x1 - cur.x0),
        h: Math.max(1, cur.y1 - cur.y0),
        text: allText.trim(),
        fontSize: cur.fontSize,
        fontStyle: blockStyle,
        kind
      });
    };

    for (const ln of lines) {
      if (!ln.text) continue;
      const isListStart = /^(\s*([-•]|(\d+)[.)]))\s+/.test(ln.text);
      if (!cur) {
        cur = { lines: [ln] as any, x0: ln.x0, y0: ln.y0, x1: ln.x1, y1: ln.y1, fontSize: ln.fontSize };
        continue;
      }
      const prev = cur.lines[cur.lines.length - 1]!;
      const gapY = ln.y0 - prev.y1;
      const indentDelta = Math.abs(ln.x0 - cur.lines[0]!.x0);

      const curIsList = /^(\s*([-•]|(\d+)[.)]))\s+/.test(cur.lines[0]!.text);
      // Lists: each bullet/number starts a new block; wrapped lines belong to the same item
      // if they are indented to the right of the bullet start.
      const listWrappedLine = curIsList && !isListStart && ln.x0 > cur.lines[0]!.x0 + medianFont * 0.8;
      const newBlock =
        gapY > lineGapTol ||
        indentDelta > indentTol ||
        (isListStart && curIsList) ||
        (isListStart && !curIsList) ||
        (!listWrappedLine && curIsList && !isListStart && indentDelta > medianFont * 0.6);
      if (newBlock) {
        pushCur();
        cur = { lines: [ln] as any, x0: ln.x0, y0: ln.y0, x1: ln.x1, y1: ln.y1, fontSize: ln.fontSize };
      } else {
        cur.lines.push(ln as any);
        cur.x0 = Math.min(cur.x0, ln.x0);
        cur.y0 = Math.min(cur.y0, ln.y0);
        cur.x1 = Math.max(cur.x1, ln.x1);
        cur.y1 = Math.max(cur.y1, ln.y1);
        cur.fontSize = Math.max(cur.fontSize, ln.fontSize);
      }
    }
    pushCur();

    return blocks;
  }

  private sampleTextAndBgColors(
    pageIndex: number,
    box: { x: number; y: number; w: number; h: number }
  ): { fg: string; bg: string; bgVariance: number } {
    const { base } = this.getCanvasPair(pageIndex);
    if (!base) return { fg: '#111111', bg: '#ffffff', bgVariance: 0 };
    const ctx = base.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { fg: '#111111', bg: '#ffffff', bgVariance: 0 };

    // Convert CSS px box to device pixels used by the canvas bitmap.
    const cssW = parseFloat(base.style.width) || base.width;
    const cssH = parseFloat(base.style.height) || base.height;
    const sx = base.width / cssW;
    const sy = base.height / cssH;

    const x0 = Math.max(0, Math.floor(box.x * sx));
    const y0 = Math.max(0, Math.floor(box.y * sy));
    const w = Math.max(1, Math.floor(box.w * sx));
    const h = Math.max(1, Math.floor(box.h * sy));

    try {
      const img = ctx.getImageData(
        x0,
        y0,
        Math.min(w, base.width - x0),
        Math.min(h, base.height - y0)
      );
      const data = img.data;

      // Background: sample just OUTSIDE the text box to avoid text pixels
      // skewing variance (common on white backgrounds).
      const m = Math.max(2, Math.min(8, Math.floor(Math.min(img.width, img.height) * 0.12)));
      const bgPts = [
        [m, 1],
        [img.width - m, 1],
        [m, img.height - 2],
        [img.width - m, img.height - 2]
      ];

      const bg = this.avgAt(data, img.width, img.height, bgPts);
      const bgVariance = this.varianceAt(data, img.width, img.height, bgPts, bg);

      // Foreground: find darkest-ish opaque pixel in region.
      let bestR = 20;
      let bestG = 20;
      let bestB = 20;
      let bestLum = 1e9;
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a < 200) continue;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (lum < bestLum) {
          bestLum = lum;
          bestR = r;
          bestG = g;
          bestB = b;
        }
      }

      return {
        fg: this.rgbToHex(bestR, bestG, bestB),
        bg: this.rgbToHex(bg.r, bg.g, bg.b),
        bgVariance
      };
    } catch {
      return { fg: '#111111', bg: '#ffffff', bgVariance: 0 };
    }
  }

  private avgAt(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    points: number[][]
  ): { r: number; g: number; b: number } {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;

    for (const [px, py] of points) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = Math.max(0, Math.min(width - 1, px + dx));
          const y = Math.max(0, Math.min(height - 1, py + dy));
          const idx = (y * width + x) * 4;
          const a = data[idx + 3];
          if (a < 200) continue;
          r += data[idx];
          g += data[idx + 1];
          b += data[idx + 2];
          n++;
        }
      }
    }

    if (n === 0) return { r: 255, g: 255, b: 255 };
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  }

  private varianceAt(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    points: number[][],
    mean: { r: number; g: number; b: number }
  ): number {
    let acc = 0;
    let n = 0;
    for (const [px, py] of points) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = Math.max(0, Math.min(width - 1, px + dx));
          const y = Math.max(0, Math.min(height - 1, py + dy));
          const idx = (y * width + x) * 4;
          const a = data[idx + 3];
          if (a < 200) continue;
          const dr = data[idx] - mean.r;
          const dg = data[idx + 1] - mean.g;
          const db = data[idx + 2] - mean.b;
          acc += dr * dr + dg * dg + db * db;
          n++;
        }
      }
    }
    if (n === 0) return 0;
    return acc / n;
  }

  private rgbToHex(r: number, g: number, b: number) {
    const to2 = (n: number) => n.toString(16).padStart(2, '0');
    return `#${to2(r)}${to2(g)}${to2(b)}`;
  }

  private inpaintRect(
    ctx: CanvasRenderingContext2D,
    source: HTMLCanvasElement,
    x: number,
    y: number,
    w: number,
    h: number,
    bitmapScale = 1
  ) {
    // `x/y/w/h` are in destination (CSS) pixels. `source` is backed by a bitmap which may
    // be device-pixel scaled, so we sample from the bitmap using `bitmapScale`.
    const stripHDest = Math.max(10, Math.min(22, Math.floor(h * 0.5)));
    const stripHSrc = Math.max(1, Math.floor(stripHDest * bitmapScale));

    const sx = Math.max(0, Math.floor(x * bitmapScale));
    const sw = Math.max(1, Math.floor(w * bitmapScale));
    const topY = Math.max(0, Math.floor((y - stripHDest - 2) * bitmapScale));
    const botY = Math.min(source.height - stripHSrc, Math.floor((y + h + 2) * bitmapScale));

    // Tile-fill from nearby strips (less “smear” than stretching one strip across the full height).
    ctx.save();
    ctx.globalAlpha = 1;

    for (let yy = y; yy < y + h; yy += stripHDest) {
      const dhDest = Math.min(stripHDest, y + h - yy);
      const dhSrc = Math.max(1, Math.floor(dhDest * bitmapScale));

      if (topY >= 0 && topY + dhSrc <= source.height) {
        ctx.drawImage(source, sx, topY, sw, dhSrc, x, yy, w, dhDest);
      }
      if (botY >= 0 && botY + dhSrc <= source.height) {
        ctx.drawImage(source, sx, botY, sw, dhSrc, x, yy, w, dhDest);
      }
    }

    ctx.restore();
  }

  protected async onPickImageFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) {
      this.pendingPdfImageDrop = null;
      this.isImagePlacing.set(false);
      return;
    }

    this.errorText.set(null);
    this.isImagePlacing.set(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Failed to read image.'));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(file);
      });
      if (!/^data:image\/(png|jpeg);base64,/i.test(dataUrl)) {
        this.errorText.set('Unsupported image (use PNG or JPEG).');
        this.pendingPdfImageDrop = null;
        this.pendingImageDataUrl = null;
        this.tool.set('text');
        return;
      }
      this.pendingImageDataUrl = dataUrl;
      this.tool.set('image');

      // If this picker was triggered by a sidebar drag+drop, place on that page/position.
      if (this.pendingPdfImageDrop) {
        const { pageIndex, x, y } = this.pendingPdfImageDrop;
        this.pendingPdfImageDrop = null;
        await this.placePendingImage(pageIndex, x, y);
      } else {
        this.redrawOverlay(this.activePageIndex());
      }
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to pick image.');
      this.pendingImageDataUrl = null;
      this.pendingPdfImageDrop = null;
    } finally {
      this.isImagePlacing.set(false);
    }
  }

  private async placePendingImage(pageIndex: number, x: number, y: number) {
    const dataUrl = this.pendingImageDataUrl;
    if (!dataUrl) return;
    if (!/^data:image\/(png|jpeg);base64,/i.test(dataUrl)) {
      this.errorText.set('Unsupported image (use PNG or JPEG).');
      this.pendingImageDataUrl = null;
      this.tool.set('text');
      return;
    }
    const { overlay } = this.getCanvasPair(pageIndex);
    if (!overlay) return;
    const rect = overlay.getBoundingClientRect();

    let img: HTMLImageElement;
    try {
      img = await this.loadHtmlImage(dataUrl);
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to decode image.');
      this.pendingImageDataUrl = null;
      this.tool.set('text');
      return;
    }

    const w0 = 180;
    const w = w0;
    const h = Math.max(10, Math.round((img.naturalHeight / Math.max(1, img.naturalWidth)) * w0));
    const cx = x - w / 2;
    const cy = y - h / 2;
    const px = clamp(cx, 0, Math.max(0, rect.width - w));
    const py = clamp(cy, 0, Math.max(0, rect.height - h));
    const id = this.newPlacedImageId();
    const anno: ImageAnno = {
      id,
      x: px,
      y: py,
      w,
      h,
      dataUrl,
      srcW: img.naturalWidth,
      srcH: img.naturalHeight
    };
    this.pushImageAnno(pageIndex, anno);
    this.selectedWidgetId.set(null);
    this.selectedPlacedImageId.set(id);
    this.pendingImageDataUrl = null;
    this.tool.set('text');
    this.redrawOverlay(pageIndex);
  }

  private loadHtmlImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to decode image.'));
      img.src = dataUrl;
    });
  }

  protected openImageCrop() {
    const id = this.selectedPlacedImageId();
    if (!id) return;
    const pageIndex = this.activePageIndex();
    const anno = this.getImageAnno(pageIndex, id);
    if (!anno) return;
    const sw = Math.max(1, anno.srcW);
    const sh = Math.max(1, anno.srcH);
    const c = anno.crop ?? { x: 0, y: 0, w: sw, h: sh };
    this.imageCropSession.set({
      pageIndex,
      id,
      leftPct: (c.x / sw) * 100,
      topPct: (c.y / sh) * 100,
      rightPct: ((sw - c.x - c.w) / sw) * 100,
      bottomPct: ((sh - c.y - c.h) / sh) * 100
    });
  }

  protected patchImageCropField(
    field: 'leftPct' | 'topPct' | 'rightPct' | 'bottomPct',
    value: number
  ) {
    const cur = this.imageCropSession();
    if (!cur) return;
    this.imageCropSession.set({ ...cur, [field]: clamp(value, 0, 49) });
  }

  protected applyImageCrop() {
    const s = this.imageCropSession();
    if (!s) return;
    const anno = this.getImageAnno(s.pageIndex, s.id);
    if (!anno) return;
    const sw = Math.max(1, anno.srcW);
    const sh = Math.max(1, anno.srcH);
    let l = clamp(s.leftPct, 0, 49);
    let t = clamp(s.topPct, 0, 49);
    let r = clamp(s.rightPct, 0, 49);
    let b = clamp(s.bottomPct, 0, 49);
    if (l + r >= 99.5) r = Math.max(0, 99.5 - l);
    if (t + b >= 99.5) b = Math.max(0, 99.5 - t);
    const x = (l / 100) * sw;
    const y = (t / 100) * sh;
    const w = Math.max(1, (1 - (l + r) / 100) * sw);
    const h = Math.max(1, (1 - (t + b) / 100) * sh);
    this.beginHistoryStep();
    this.updatePlacedImage(s.pageIndex, s.id, (a) => ({
      ...a,
      crop: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
    }));
    this.imageCropSession.set(null);
    this.redrawOverlay(s.pageIndex);
  }

  protected cancelImageCrop() {
    this.imageCropSession.set(null);
  }

  protected removeSelectedPlacedImage() {
    const id = this.selectedPlacedImageId();
    if (!id) return;
    const pageIndex = this.activePageIndex();
    this.beginHistoryStep();
    this.editsByPage.update((prev) => {
      const ex = prev[pageIndex];
      if (!ex) return prev;
      return {
        ...prev,
        [pageIndex]: { ...ex, images: (ex.images ?? []).filter((im) => im.id !== id) }
      };
    });
    this.selectedPlacedImageId.set(null);
    this.imageCropSession.set(null);
    this.redrawOverlay(pageIndex);
  }

  private async embedPlacedImageForPdf(pdf: PDFDocument, anno: ImageAnno) {
    const el = await this.loadHtmlImage(anno.dataUrl);
    const { sx, sy, sw, sh } = this.getSourceRectForPlaced(anno, el);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.floor(sw));
    c.height = Math.max(1, Math.floor(sh));
    const cctx = c.getContext('2d');
    if (!cctx) throw new Error('Canvas unavailable.');
    cctx.drawImage(el, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const png = c.toDataURL('image/png');
    const { bytes } = this.dataUrlToBytes(png);
    return pdf.embedPng(bytes);
  }

  private async drawImagesToPdf(
    pdf: PDFDocument,
    page: PDFPage,
    edit: PageEdits,
    sx: number,
    sy: number
  ) {
    if (edit.images.length === 0) return;
    const { height } = page.getSize();

    for (const img of edit.images) {
      const embedded = await this.embedPlacedImageForPdf(pdf, img);
      page.drawImage(embedded, {
        x: img.x * sx,
        y: height - (img.y + img.h) * sy,
        width: img.w * sx,
        height: img.h * sy
      });
    }
  }

  private dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; kind: 'png' | 'jpg' } {
    const m = /^data:(image\/png|image\/jpeg);base64,(.+)$/i.exec(dataUrl);
    if (!m) throw new Error('Unsupported image format (only PNG/JPEG).');
    const mime = m[1].toLowerCase();
    const b64 = m[2];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, kind: mime.includes('png') ? 'png' : 'jpg' };
  }
}

