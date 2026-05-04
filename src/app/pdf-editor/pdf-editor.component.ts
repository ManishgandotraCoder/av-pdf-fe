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
import { toSignal } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs/operators';
  import {
    AnnotationType,
    GlobalWorkerOptions,
    getDocument,
    OPS,
    Util,
    type PDFDocumentProxy
  } from 'pdfjs-dist';
import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import {
  PdfApiService,
  type CrmAssetLibraryCategory,
  type CrmAssetLibraryItem,
  type PdfEditorStateV2,
  type ProposalDetails,
  type ProposalRejection,
  type ProposalVersion,
  type RejectionLevel,
  type ShareAccessType,
  type ShareRole,
  type ShareUser
} from '../pdf-api/pdf-api.service';
import { AssetMetaService } from '../asset-meta/asset-meta.service';

type Tool = 'pan' | 'pen' | 'text';
type FontStyle = 'regular' | 'bold' | 'italic' | 'boldItalic';
type FontFamily =
  | 'helvetica'
  | 'arial'
  | 'calibri'
  | 'times'
  | 'georgia'
  | 'cambria'
  | 'garamond'
  | 'courier'
  | 'verdana'
  | 'tahoma'
  | 'trebuchet_ms'
  | 'poppins'
  | 'montserrat'
  | 'abcdee_helvetica_bold';

type WidgetKind = 'table' | 'text';
type Widget = {
  id: string;
  kind: WidgetKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Plain text for text widgets */
  textValue?: string;
  /** Basic editable table model */
  table?: { rows: number; cols: number; cells: string[][] };
};

type InsertWidgetPending = {
  kind: 'table';
};

type ReusableAsset = {
  id: string;
  kind: 'template';
  label: string;
  source: 'upload' | 'url' | 'crm';
  imageSrc?: string;
  createdAt: number;
  categoryId?: string;
  categoryLabel?: string;
  crmAssetId?: string;
};

type AssetLibraryRow =
  | { rowKind: 'local'; asset: ReusableAsset }
  | { rowKind: 'crm'; item: CrmAssetLibraryItem };

type PersistedEditorState = {
  version: 2;
  fileName?: string;
  editsByPage: Record<number, PageEdits>;
  widgetsByPage: Record<number, PersistedWidget[]>;
};

type PersistedWidget = {
  id: string;
  kind: WidgetKind;
  x: number;
  y: number;
  w: number;
  h: number;
  textValue?: string;
  table?: { rows: number; cols: number; cells: string[][] };
};

type PersistedMediaWidgetsByPage = Record<number, PersistedWidget[]>;

type FurnitureAlignment = 'left' | 'center' | 'right';
type PageNumberFormat = '1' | '1 / N' | 'Page 1 of N';
type PageNumberPosition = 'header-left' | 'header-right' | 'footer-left' | 'footer-center' | 'footer-right';

type PageFurniture = {
  proposalTitle: string;
  clientName: string;
  header: {
    content: string;
    alignment: FurnitureAlignment;
    visible: boolean;
  };
  footer: {
    leftContent: string;
    centerContent: string;
    rightContent: string;
    visible: boolean;
    divider: boolean;
  };
  pageNumber: {
    visible: boolean;
    format: PageNumberFormat;
    position: PageNumberPosition;
    startFrom: number;
  };
  logo: {
    url: string;
    position: 'header-left' | 'header-right';
    width: number;
    height: number;
    keepAspectRatio: boolean;
    linkUrl: string;
    visible: boolean;
  };
};

const DEFAULT_PAGE_FURNITURE: PageFurniture = {
  proposalTitle: '',
  clientName: '',
  header: {
    content: '{{proposalTitle}}',
    alignment: 'left',
    visible: false
  },
  footer: {
    leftContent: '',
    centerContent: '',
    rightContent: '',
    visible: false,
    divider: false
  },
  pageNumber: {
    visible: true,
    format: '1 / N',
    position: 'footer-right',
    startFrom: 1
  },
  logo: {
    url: '',
    position: 'header-left',
    width: 96,
    height: 32,
    keepAspectRatio: true,
    linkUrl: '',
    visible: false
  }
};

function clonePageFurniture(f: PageFurniture): PageFurniture {
  return {
    proposalTitle: f.proposalTitle,
    clientName: f.clientName,
    header: { ...f.header },
    footer: { ...f.footer },
    pageNumber: { ...f.pageNumber },
    logo: { ...f.logo }
  };
}

const DEFAULT_GLOBAL_TYPOGRAPHY: GlobalTypographySettings = {
  heading: { fontFamily: 'helvetica', size: 26, bold: true, italic: false, color: '#111827' },
  subheading: { fontFamily: 'helvetica', size: 20, bold: true, italic: false, color: '#1f2937' },
  body: { fontFamily: 'helvetica', size: 16, bold: false, italic: false, color: '#111827' }
};

function cloneGlobalTypography(v: GlobalTypographySettings): GlobalTypographySettings {
  return {
    heading: { ...v.heading },
    subheading: { ...v.subheading },
    body: { ...v.body }
  };
}

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** Normalize a CSS color to `#rrggbb` for `<input type="color">`, or null if unsupported. */
function cssColorToHex6ForColorInput(input: string | undefined | null): string | null {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  if (s[0] === '#') {
    const hex = s.slice(1);
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
      const a = hex[0]!;
      const b = hex[1]!;
      const c = hex[2]!;
      return `#${a}${a}${b}${b}${c}${c}`.toLowerCase();
    }
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return `#${hex.toLowerCase()}`;
    }
    if (/^[0-9a-fA-F]{8}$/.test(hex)) {
      return `#${hex.slice(0, 6).toLowerCase()}`;
    }
    return null;
  }
  const rgb = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    const r = clampByte(parseInt(rgb[1]!, 10));
    const g = clampByte(parseInt(rgb[2]!, 10));
    const b = clampByte(parseInt(rgb[3]!, 10));
    const h = (n: number) => n.toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`;
  }
  return null;
}

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
  /** Stable id for selection / delete (overlay text boxes). */
  id: string;
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

type PlacedImageEdge = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

type TextDraftResizeEdge = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

type ActiveTextDraftGesture =
  | {
    pageIndex: number;
    pointerId: number;
    kind: 'move';
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  }
  | {
    pageIndex: number;
    pointerId: number;
    kind: 'resize';
    edge: TextDraftResizeEdge;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
  };
type WidgetResizeEdge = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se' | 'br';
type ActivePlacedImageOp = {
  pageIndex: number;
  id: string;
  pointerId: number;
  mode: 'move' | 'resize';
  edge: PlacedImageEdge | null;
  startX: number;
  startY: number;
  orig: { x: number; y: number; w: number; h: number };
  /** Undo snapshot is taken on first real geometry change, not on click-to-select. */
  historyBegun?: boolean;
};

type ActivePlacedTextOp = {
  pageIndex: number;
  id: string;
  pointerId: number;
  mode: 'move' | 'resize';
  edge: PlacedImageEdge | null;
  startX: number;
  startY: number;
  /** Full snapshot at gesture start (for resize blending / collision). */
  annoStart: TextAnno;
  /** Snapshot at gesture start: position, measured bounds, font size. */
  orig: { x: number; y: number; w: number; h: number; fontSize: number };
};

type DetectedText = {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize: number;
  fontStyle: FontStyle;
  fontFamily: FontFamily;
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
  fontFamily: FontFamily;
  kind: DetectedBlockKind;
};

/** Raster images / masks from content streams, plus movie/screen annotations (viewport CSS px). */
type DetectedPdfMedia = {
  id: string;
  kind: 'image' | 'video';
  x: number;
  y: number;
  w: number;
  h: number;
};

/** One reading-order region: grouped text or embedded image / video (viewport CSS px). */
type PdfLayoutRegion =
  | { regionKind: 'text'; block: DetectedBlock }
  | { regionKind: 'media'; media: DetectedPdfMedia };

type SidebarSectionType = 'section' | 'imageHeader';
type EditHistoryEventKind = 'apply' | 'undo' | 'redo' | 'clear';
type EditHistoryEvent = {
  id: string;
  kind: EditHistoryEventKind;
  label: string;
  at: number;
};
type EditorHistorySnapshot = {
  editsByPage: Record<number, PageEdits>;
  widgetsByPage: Record<number, Widget[]>;
};

type KeySlotKind = 'fixed' | 'custom';
type KeySlot = { id: string; title: string; kind: KeySlotKind };

type GlobalTypographySection = {
  fontFamily: FontFamily;
  size: number;
  bold: boolean;
  italic: boolean;
  color: string;
};

type GlobalTypographySettings = {
  heading: GlobalTypographySection;
  subheading: GlobalTypographySection;
  body: GlobalTypographySection;
};

type TextReplace = {
  /** Mask rectangle used to erase original/previous text. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Text draw anchor. Older saved edits fall back to x/y. */
  textX?: number;
  textY?: number;
  /** Max line width for wrapped replacement text. Older saved edits fall back to w. */
  textWrapWidth?: number;
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
  source?: 'textEdit' | 'mediaErase' | 'globalTypography';
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

function axisRectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) return false;
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function pdfLayoutRegionSortKey(r: PdfLayoutRegion): [number, number] {
  const b = r.regionKind === 'text' ? r.block : r.media;
  return [b.y, b.x];
}

/** Merges detected text blocks and embedded media, sorted top-to-bottom then left-to-right (LTR). */
function buildPdfLayoutRegions(blocks: DetectedBlock[], media: DetectedPdfMedia[]): PdfLayoutRegion[] {
  const out: PdfLayoutRegion[] = blocks.map((block) => ({ regionKind: 'text' as const, block }));
  for (const m of media) {
    out.push({ regionKind: 'media', media: m });
  }
  out.sort((a, b) => {
    const [ay, ax] = pdfLayoutRegionSortKey(a);
    const [by, bx] = pdfLayoutRegionSortKey(b);
    if (ay !== by) return ay - by;
    if (ax !== bx) return ax - bx;
    if (a.regionKind !== b.regionKind) return a.regionKind === 'text' ? -1 : 1;
    return 0;
  });
  return out;
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

function inferFontFamilyFromPdfJsStyle(raw: any): FontFamily {
  const a = String(raw?.fontFamily ?? '').toLowerCase();
  const b = String(raw?.fontName ?? '').toLowerCase();
  const c = String(raw?.name ?? '').toLowerCase();
  const combined = `${a} ${b} ${c}`;
  if (combined.includes('abcdee') && combined.includes('helvetica') && combined.includes('bold')) {
    return 'abcdee_helvetica_bold';
  }
  if (combined.includes('montserrat')) return 'montserrat';
  if (combined.includes('poppins')) return 'poppins';
  if (combined.includes('trebuchet')) return 'trebuchet_ms';
  if (combined.includes('verdana')) return 'verdana';
  if (combined.includes('tahoma')) return 'tahoma';
  if (combined.includes('calibri')) return 'calibri';
  if (combined.includes('cambria')) return 'cambria';
  if (combined.includes('garamond')) return 'garamond';
  if (combined.includes('georgia')) return 'georgia';
  if (combined.includes('arial')) return 'arial';
  if (combined.includes('courier')) return 'courier';
  if (combined.includes('times')) return 'times';
  if (combined.includes('serif') || combined.includes('roman')) return 'times';
  if (combined.includes('mono')) return 'courier';
  return 'helvetica';
}

function dominantFontFamily(families: FontFamily[]): FontFamily {
  if (families.length === 0) return 'helvetica';
  const counts: Partial<Record<FontFamily, number>> = {};
  for (const family of families) counts[family] = (counts[family] ?? 0) + 1;
  const ranked = Object.entries(counts) as [FontFamily, number][];
  ranked.sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? 'helvetica';
}

function cssFontFamily(f: FontFamily): string {
  if (f === 'abcdee_helvetica_bold') return '"Helvetica Neue", Arial, sans-serif';
  if (f === 'arial') return 'Arial, "Helvetica Neue", Helvetica, sans-serif';
  if (f === 'calibri') return 'Calibri, "Segoe UI", Arial, sans-serif';
  if (f === 'poppins') return '"Poppins", "Helvetica Neue", Arial, sans-serif';
  if (f === 'montserrat') return '"Montserrat", "Poppins", "Helvetica Neue", Arial, sans-serif';
  if (f === 'georgia') return 'Georgia, "Times New Roman", Times, serif';
  if (f === 'cambria') return 'Cambria, Georgia, "Times New Roman", serif';
  if (f === 'garamond') return 'Garamond, "Times New Roman", serif';
  if (f === 'times') return '"Times New Roman", Times, serif';
  if (f === 'courier') return '"Courier New", Courier, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
  if (f === 'verdana') return 'Verdana, Geneva, sans-serif';
  if (f === 'tahoma') return 'Tahoma, "Segoe UI", sans-serif';
  if (f === 'trebuchet_ms') return '"Trebuchet MS", Tahoma, Arial, sans-serif';
  return 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial';
}

type PdfExportFontFamily = 'helvetica' | 'times' | 'courier';
function normalizePdfExportFontFamily(family: FontFamily): PdfExportFontFamily {
  if (family === 'times' || family === 'georgia' || family === 'cambria' || family === 'garamond') return 'times';
  if (family === 'courier') return 'courier';
  return 'helvetica';
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

  /** Reactive `:id` so in-place navigation (e.g. save-as-new version) reloads doc + version list. */
  private readonly editRouteId = toSignal(
    this.route.paramMap.pipe(map((pm) => pm.get('id'))),
    { initialValue: this.route.snapshot.paramMap.get('id') }
  );
  private readonly editRouteReadonly = toSignal(
    this.route.queryParamMap.pipe(map((qm) => qm.get('readonly') === '1')),
    { initialValue: this.route.snapshot.queryParamMap.get('readonly') === '1' }
  );
  private readonly api = inject(PdfApiService);
  private readonly assetMeta = inject(AssetMetaService);

  protected readonly Math = Math;
  protected readonly range = (n: number) => Array.from({ length: Math.max(0, n) }, (_, i) => i);

  private renderAllPagesEpoch = 0;
  private readonly renderTaskByPage = new Map<number, any>();

  /** Cancel every tracked pdf.js render before swapping bytes/doc so stale tasks cannot paint wrong pixels. */
  private cancelAllPdfRenderTasks(): void {
    for (const task of this.renderTaskByPage.values()) {
      try {
        task?.cancel?.();
      } catch {
        // ignore
      }
    }
    this.renderTaskByPage.clear();
  }

  private readonly undoStack: EditorHistorySnapshot[] = [];
  private readonly redoStack: EditorHistorySnapshot[] = [];
  private readonly undoLabels: string[] = [];
  private readonly redoLabels: string[] = [];
  private readonly maxHistoryEntries = 200;
  protected readonly editHistoryEvents = signal<EditHistoryEvent[]>([]);

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
  protected readonly textSizeInput = signal('18');
  protected readonly textStyle = signal<FontStyle>('regular');
  protected readonly textFamily = signal<FontFamily>('helvetica');
  protected readonly textBgEnabled = signal(false);
  protected readonly textBgColor = signal('#ffffff');
  protected readonly editExistingText = signal(true);
  /** When false, embedded-text detection is skipped and PDF text/editing widgets are inactive. */
  protected readonly textFeatureEnabled = signal(true);
  // Default PDF display at 80%.
  private static readonly minZoom = 0.1;
  private static readonly maxZoom = 2.5;
  private static readonly zoomStep = 0.1;
  protected readonly scale = signal(0.8);
  protected readonly sidebarCollapsed = signal(false);

  /** Fixed key-page slots always present in the left navigation. */
  private static readonly fixedKeySlots: KeySlot[] = [
    // { id: 'with', title: 'W/', kind: 'fixed' },
    // { id: 'project', title: 'Project', kind: 'fixed' },
    // { id: 'gut', title: 'Gut', kind: 'fixed' },
    // { id: 'cover_letter', title: 'Cover Letter', kind: 'fixed' },
    // { id: 'acceptance', title: 'Acceptance', kind: 'fixed' }
  ];

  /** Instance alias for templates (section pills + custom slot index base). */
  protected readonly fixedKeySlotsForNav: KeySlot[] = PdfEditorComponent.fixedKeySlots;

  protected readonly customKeySlots = signal<KeySlot[]>([]);
  protected readonly keySlotDragFromCustomIndex = signal<number | null>(null);
  protected readonly keySlotPageCount = computed(() => PdfEditorComponent.fixedKeySlots.length + this.customKeySlots().length);

  /** Right inspector: tooling vs library (250px rail). */

  protected readonly rightbarTab = signal<'options' | 'settings' | 'typography' | 'assets' | 'versions'>('options');
  /** Top-level panel: insert tools vs CRM asset library (matches studio sidebar mockup). */
  protected readonly rightbarPrimaryTab = signal<'elements' | 'assets'>('elements');
  protected readonly insertSourceMenu = signal<'image' | 'video' | null>(null);
  protected readonly rightbarInsertLibraryCollapsed = signal(false);
  /** Collapses search, categories, and asset grid on the Assets Library tab. */
  protected readonly rightbarAssetLibraryBrowserCollapsed = signal(false);
  protected readonly rightbarFrequentCollapsed = signal(false);
  protected readonly rightbarLayoutCollapsed = signal(false);
  protected readonly rightbarBaseCollapsed = signal(false);
  protected readonly reusableAssets = signal<ReusableAsset[]>([]);
  protected readonly assetLibrarySearch = signal('');
  protected readonly assetLibraryCategoryId = signal<string | null>(null);
  protected readonly crmAssetCategories = signal<CrmAssetLibraryCategory[]>([]);
  protected readonly crmAssetItems = signal<CrmAssetLibraryItem[]>([]);
  protected readonly assetLibraryLoading = signal(false);
  protected readonly assetLibraryError = signal<string | null>(null);
  protected readonly crmLibraryConfigured = signal(false);
  protected readonly replaceMediaTarget = signal<{ pageIndex: number; widgetId: string; kind: 'image' | 'video' } | null>(null);

  private static readonly reusableAssetsStorageKey = 'avyro-editor-reusable-assets:v1';
  private static readonly maxPersistedReusableAssets = 64;
  private crmAssetFetchSeq = 0;

  protected readonly assetLibraryRows = computed(() => {
    const q = this.assetLibrarySearch().trim().toLowerCase();
    const cat = this.assetLibraryCategoryId();
    const crmItems = this.crmAssetItems();
    const locals = this.reusableAssets();
    const rows: AssetLibraryRow[] = [];
    for (const asset of locals) {
      if (q && !asset.label.toLowerCase().includes(q)) continue;
      rows.push({ rowKind: 'local', asset });
    }
    for (const item of crmItems) {
      if (cat && item.categoryId !== cat) continue;
      if (q && !item.name.toLowerCase().includes(q)) continue;
      rows.push({ rowKind: 'crm', item });
    }
    return rows;
  });

  /**
   * After picking a file, erase the embedded PDF region then place the new asset (Shift+click on detected media).
   * Separate from widget `replaceMediaTarget` so we do not change widget replace behaviour.
   */
  private embeddedMediaReplaceTarget: {
    pageIndex: number;
    id: string;
    kind: 'image' | 'video';
    x: number;
    y: number;
    w: number;
    h: number;
  } | null = null;
  private placedImageReplaceTarget: { pageIndex: number; id: string } | null = null;
  protected readonly selectedDetectedPdfMedia = signal<{ pageIndex: number; media: DetectedPdfMedia } | null>(null);

  protected readonly imageUploadCropModal = signal<{
    dataUrl: string;
    leftPct: number;
    topPct: number;
    rightPct: number;
    bottomPct: number;
  } | null>(null);
  private imageUploadCropResolve: ((value: string | null) => void) | null = null;
  private activeUploadCropHandle:
    | {
      pointerId: number;
      handle: 'tl' | 'tr' | 'bl' | 'br';
      startClientX: number;
      startClientY: number;
      start: { leftPct: number; topPct: number; rightPct: number; bottomPct: number };
    }
    | null = null;

  protected readonly openDocsMenu = signal<'Insert' | null>(null);

  protected readonly widgetsByPage = signal<Record<number, Widget[]>>({});
  protected readonly selectedWidgetId = signal<string | null>(null);
  protected readonly pageFurniture = signal<PageFurniture>(clonePageFurniture(DEFAULT_PAGE_FURNITURE));
  protected readonly proposalTitleDraft = signal(DEFAULT_PAGE_FURNITURE.proposalTitle);
  protected readonly clientNameDraft = signal(DEFAULT_PAGE_FURNITURE.clientName);
  protected readonly hasUnsavedDynamicFields = computed(() => {
    const furniture = this.pageFurniture();
    return this.proposalTitleDraft() !== furniture.proposalTitle || this.clientNameDraft() !== furniture.clientName;
  });
  private logoNaturalAspect = 1;
  private furnitureSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private furniturePersistenceReady = false;

  @ViewChild('pdfImageFile') private readonly pdfImageFile?: ElementRef<HTMLInputElement>;
  @ViewChild('widgetImageFile') private readonly widgetImageFile?: ElementRef<HTMLInputElement>;
  @ViewChild('widgetVideoFile') private readonly widgetVideoFile?: ElementRef<HTMLInputElement>;
  @ViewChild('widgetSignatureFile') private readonly widgetSignatureFile?: ElementRef<HTMLInputElement>;
  @ViewChild('furnitureLogoFile') private readonly furnitureLogoFile?: ElementRef<HTMLInputElement>;
  @ViewChild('textDraftEditor') private readonly textDraftEditor?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('uploadCropSurface') private readonly uploadCropSurface?: ElementRef<HTMLDivElement>;

  /** Click insert flow: pick type (and file for image/video), then click the page to place. */
  protected readonly insertWidgetPending = signal<InsertWidgetPending | null>(null);
  protected readonly editingWidgetId = signal<string | null>(null);
  private signaturePickTargetWidgetId: string | null = null;
  private layeredImagePickTargetWidgetId: string | null = null;

  private readonly videoObjectUrlByWidgetId = new Map<string, string>();
  /** Maps detected embedded-media id → replacement overlay id (session-only; survives slight re-detection drift). */
  private readonly embeddedImageReplacementByDetectedId = new Map<string, string>();
  private hoveredDetectedPdfImage:
    | { pageIndex: number; media: DetectedPdfMedia; part: 'body' | PlacedImageEdge }
    | null = null;
  private readonly persistedVideoDbName = 'avyro-editor-media';
  private readonly persistedVideoStoreName = 'videoByRef';

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
  private activePlacedTextOp: ActivePlacedTextOp | null = null;
  private activeTextDraftGesture: ActiveTextDraftGesture | null = null;
  private static readonly placedImageHandlePx = 7;
  private static readonly placedImageHandleHit = 10;
  private static readonly textDraftToolbarGapPx = 6;
  private static readonly textDraftToolbarHeightPx = 38;
  private static readonly placedTextClosePx = 26;
  private static readonly placedTextCloseHitPad = 4;

  protected readonly selectedPlacedImageId = signal<string | null>(null);
  protected readonly selectedPlacedTextId = signal<string | null>(null);
  protected readonly imageCropSession = signal<
    | {
      mode: 'placed';
      pageIndex: number;
      id: string;
      leftPct: number;
      topPct: number;
      rightPct: number;
      bottomPct: number;
    }
    | {
      mode: 'widget';
      pageIndex: number;
      widgetId: string;
      leftPct: number;
      topPct: number;
      rightPct: number;
      bottomPct: number;
    }
    | null
  >(null);

  protected readonly isLoading = signal(false);
  /** Shown in the busy overlay while `isLoading` (and related) is true. */
  protected readonly busyHint = signal('Working…');
  protected readonly errorText = signal<string | null>(null);
  protected readonly isInserting = signal(false);
  protected readonly isPageRendering = signal(false);

  protected readonly docId = signal<string | null>(null);
  protected readonly isCreateFlow = signal(false);
  protected readonly overwriteConfirmOpen = signal(false);
  protected readonly rejectConfirmOpen = signal(false);
  protected readonly clearAllEditsConfirmOpen = signal(false);
  protected readonly clearingAllEdits = signal(false);
  protected readonly rejectConfirmLevel = signal<RejectionLevel>('internal');
  protected readonly sharePanelOpen = signal(false);
  protected readonly shareAccessType = signal<ShareAccessType>('restricted');
  protected readonly shareUrl = signal('');
  protected readonly shareUsers = signal<ShareUser[]>([]);
  protected readonly shareEmailInput = signal('');
  protected readonly shareRoleInput = signal<ShareRole>('viewer');
  protected readonly shareBusy = signal(false);
  protected readonly lastShareRecord = signal<{
    sharedBy: string;
    sharedAt: number;
  } | null>(null);
  protected readonly proposalDetails = signal<ProposalDetails | null>(null);
  protected readonly rejection = signal<ProposalRejection | null>(null);
  protected readonly rejectionReasonInput = signal('');
  protected readonly rejectionBusy = signal(false);
  protected readonly readonlyMode = signal(false);
  protected readonly traceabilityHint =
    'Helps track origin and maintain version lineage';
  protected readonly versionHistory = signal<ProposalVersion[]>([]);
  protected readonly isVersionHistoryLoading = signal(false);
  protected readonly isAutoVersionSaving = signal(false);
  protected readonly globalTypography = signal<GlobalTypographySettings>(cloneGlobalTypography(DEFAULT_GLOBAL_TYPOGRAPHY));
  private autoVersionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private editorRemoteSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private autoVersionSaveInFlight = false;
  private autoVersionSavePending = false;
  private autoVersionSnapshotReady = false;
  private lastAutoVersionSnapshot = '';

  private pdfBytes: Uint8Array | null = null;
  private pdfDoc: PDFDocumentProxy | null = null;
  private editorSourceProposalId: string | null = null;

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
  protected readonly sectionOverridesByPage = signal<Record<number, { title: string; type: SidebarSectionType }>>({});
  protected readonly removedSectionsByPage = signal<Record<number, true>>({});
  protected readonly sidebarSectionByPage = computed<Record<number, { title: string; type: SidebarSectionType } | null>>(
    () => {
      const count = this.pageCount();
      const byPage = this.detectedBlocksByPage();
      const overrides = this.sectionOverridesByPage();
      const removed = this.removedSectionsByPage();
      const edits = this.editsByPage();
      const out: Record<number, { title: string; type: SidebarSectionType } | null> = {};
      for (let pageIndex = 0; pageIndex < count; pageIndex++) {
        if (removed[pageIndex]) {
          out[pageIndex] = null;
          continue;
        }
        const override = overrides[pageIndex];
        if (override) {
          out[pageIndex] = override;
          continue;
        }
        const rawBlocks = byPage[pageIndex] ?? [];
        const replaces = edits[pageIndex]?.replaces ?? [];
        const merged = this.detectedBlocksWithTextReplacesApplied(rawBlocks, replaces);
        out[pageIndex] = this.resolveSidebarSectionMeta(merged);
      }
      return out;
    }
  );
  protected readonly activePageIndex = signal(0);
  protected readonly openPageMenuIndex = signal<number | null>(null);
  protected readonly deleteSlideModalOpen = signal(false);
  protected readonly deleteSlideTargetIndex = signal<number | null>(null);
  /** Short-lived UX messages (toast) for slide management */
  protected readonly slideToast = signal<string | null>(null);
  private slideToastClearTimer: ReturnType<typeof setTimeout> | null = null;
  /** Short-lived error toast UX */
  private errorToastClearTimer: ReturnType<typeof setTimeout> | null = null;
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
  protected readonly detectedMediaByPage = signal<Record<number, DetectedPdfMedia[]>>({});
  /** Text blocks and embedded media in document reading order per page (for layout-aware tools / UI). */
  protected readonly layoutRegionsByPage = computed<Record<number, PdfLayoutRegion[]>>(() => {
    const n = this.pageCount();
    const blocksByPage = this.detectedBlocksByPage();
    const mediaByPage = this.detectedMediaByPage();
    const out: Record<number, PdfLayoutRegion[]> = {};
    for (let i = 0; i < n; i++) {
      out[i] = buildPdfLayoutRegions(blocksByPage[i] ?? [], mediaByPage[i] ?? []);
    }
    return out;
  });
  private readonly baseSnapshotByPage = new Map<number, ImageData>();
  private readonly pageRotateByPage = new Map<number, number>();

  private activeInk:
    | { pageIndex: number; stroke: InkStroke; pointerId: number; lastPoint?: InkPoint }
    | null = null;

  private editingReplace: { pageIndex: number; idx: number } | null = null;
  private suppressCommitOnBlurOnce = false;
  private textDraftSelection: { start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null = null;

  protected readonly isTextPlacing = signal(false);
  protected readonly textDraft = signal('');
  protected readonly textDraftPageIndex = signal<number | null>(null);
  protected readonly textDraftX = signal(0);
  protected readonly textDraftY = signal(0);
  private textDraftBox:
    | {
      w: number;
      h: number;
      maskX: number;
      maskY: number;
      maskW: number;
      maskH: number;
      oldText: string;
      bgColor: string;
      color: string;
      maskMode: 'color' | 'inpaint';
      fontSize: number;
      fontStyle: FontStyle;
      fontFamily: FontFamily;
    }
    | null = null;
  /** When adding new overlay text (no mask box), layout size for the in-page editor. */
  private readonly textDraftFreeRect = signal<{ w: number; h: number }>({ w: 320, h: 44 });

  protected readonly isImagePlacing = signal(false);
  private pendingImageDataUrl: string | null = null;
  private sidebarSectionDetectEpoch = 0;

  constructor() {
    // Emit via angular.json assets (see pdfjs-dist/build) so prod deploy serves a real file;
    // new URL(import.meta.url) resolves to /pdfjs-dist/... which is covered by SPA rewrites unless the file exists in dist.
    GlobalWorkerOptions.workerSrc = '/pdfjs-dist/build/pdf.worker.min.mjs';

    this.hydrateReusableAssetsFromStorage();

    effect(() => {
      // Re-render pages when zoom changes.
      const _ = this.scale();
      void this.renderActivePage();
    });

    effect(() => {
      this.textSizeInput.set(String(this.textSize()));
    });

    effect(() => {
      // Re-render when switching pages.
      const _ = this.activePageIndex();
      void this.renderActivePage();
    });

    // Load the selected PDF from the library (route param).
    effect(() => {
      const id = this.editRouteId();
      this.isCreateFlow.set(!id);
      this.readonlyMode.set(this.editRouteReadonly());
      this.furniturePersistenceReady = false;
      this.docId.set(id);
      this.autoVersionSnapshotReady = false;
      this.lastAutoVersionSnapshot = '';
      this.shareUrl.set('');
      this.shareUsers.set([]);
      this.shareAccessType.set('restricted');
      this.lastShareRecord.set(null);
      if (id) {
        void this.loadFromApi(id);
        void this.loadProposalVersions(id);
        void this.loadProposalDetails(id);
        void this.loadProposalRejection(id);
      } else {
        this.proposalDetails.set(null);
        this.rejection.set(null);
      }
    });

    effect(() => {
      const currentTab = this.rightbarTab();
      const allowed = ['options', 'settings', 'typography', 'assets', 'versions'] as const;
      if (!allowed.includes(currentTab as any)) {
        this.rightbarTab.set('options');
      }
    });

    effect(() => {
      const primary = this.rightbarPrimaryTab();
      const create = this.isCreateFlow();
      if (primary === 'assets' && !create) {
        void this.refreshCrmAssetLibrary();
      }
      if (create && primary === 'assets') {
        this.rightbarPrimaryTab.set('elements');
        this.rightbarTab.set('options');
      }
    });

    effect(() => {
      const id = this.docId();
      const furniture = this.pageFurniture();
      if (!id || !this.furniturePersistenceReady || this.readonlyMode()) return;
      this.scheduleFurnitureSave(id, furniture);
    });

    effect(() => {
      const id = this.docId();
      const edits = this.editsByPage();
      const widgets = this.widgetsByPage();
      const furniture = this.pageFurniture();
      const pageCount = this.pageCount();
      const fileName = this.fileName();
      if (!id || pageCount === 0 || this.readonlyMode()) return;
      const snapshot = this.autoVersionSnapshotFingerprint(edits, widgets, furniture, pageCount, fileName);
      if (!this.autoVersionSnapshotReady) {
        this.autoVersionSnapshotReady = true;
        this.lastAutoVersionSnapshot = snapshot;
        return;
      }
      if (snapshot === this.lastAutoVersionSnapshot) return;
      this.lastAutoVersionSnapshot = snapshot;
      this.scheduleAutoVersionSave();
    });

    // Auto-dismiss error banners toasts.
    effect(() => {
      const msg = this.errorText();
      if (!msg) return;
      if (this.errorToastClearTimer !== null) clearTimeout(this.errorToastClearTimer);
      this.errorToastClearTimer = setTimeout(() => {
        this.errorToastClearTimer = null;
        this.errorText.set(null);
      }, 4200);
    });
  }

  protected readonly zoomOptions = [0.25, 0.5, 0.75, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4] as const;
  protected readonly fontSizeOptions = [
    8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 56, 64, 72
  ] as const;
  protected readonly fontFamilyOptions: { label: string; value: FontFamily }[] = [
    { label: 'Helvetica', value: 'helvetica' },
    { label: 'Times', value: 'times' },
    { label: 'Courier', value: 'courier' },
    { label: 'Poppins', value: 'poppins' },
    { label: 'Montserrat', value: 'montserrat' },
    { label: 'Helvetica Bold (subset)', value: 'abcdee_helvetica_bold' }
  ];

  /** Preset sizes plus current value when it is not in the list (e.g. legacy documents). */
  protected fontSizeOptionsForGlobalTypography(size: number): number[] {
    const base = this.fontSizeOptions as readonly number[];
    if (base.includes(size)) return [...base];
    return [...base, size].sort((a, b) => a - b);
  }

  private normalizeZoom(value: number): number {
    // Round to avoid precision artifacts from repeated +/- step operations.
    return Number(value.toFixed(2));
  }

  private clampZoom(value: number): number {
    return this.normalizeZoom(Math.min(PdfEditorComponent.maxZoom, Math.max(PdfEditorComponent.minZoom, value)));
  }

  private applyZoomDelta(delta: number): void {
    this.scale.set(this.clampZoom(this.scale() + delta));
  }

  protected toggleItalic() {
    this.applyTextToolbarChange(() => {
      const current = this.textStyle();
      const isItalic = current === 'italic' || current === 'boldItalic';
      const weight = this.textWeight();
      if (isItalic) {
        this.textStyle.set(weight === 700 ? 'bold' : 'regular');
      } else {
        this.textStyle.set(weight === 700 ? 'boldItalic' : 'italic');
      }
    });
  }

  protected toggleBold() {
    this.applyTextToolbarChange(() => {
      this.setTextWeight(this.textWeight() === 700 ? 400 : 700);
    });
  }

  protected toggleTextBgEnabled() {
    this.applyTextToolbarChange(() => {
      this.textBgEnabled.set(!this.textBgEnabled());
    });
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

  protected toggleRightbarInsertLibrary() {
    this.rightbarInsertLibraryCollapsed.update((v) => !v);
  }

  protected toggleRightbarAssetLibraryBrowser() {
    this.rightbarAssetLibraryBrowserCollapsed.update((v) => !v);
  }

  protected toggleRightbarSection(which: 'frequent' | 'layout' | 'base') {
    if (which === 'frequent') this.rightbarFrequentCollapsed.update((v) => !v);
    else if (which === 'layout') this.rightbarLayoutCollapsed.update((v) => !v);
    else this.rightbarBaseCollapsed.update((v) => !v);
  }

  protected setRightbarPrimaryTab(mode: 'elements' | 'assets') {
    if (mode === 'elements') {
      this.rightbarPrimaryTab.set('elements');
      this.rightbarTab.set('options');
      return;
    }
    if (!this.isCreateFlow()) {
      this.rightbarPrimaryTab.set('assets');
      this.rightbarTab.set('assets');
    }
  }

  protected openRightbarDocumentPanel(panel: 'settings' | 'typography' | 'versions') {
    this.rightbarPrimaryTab.set('elements');
    this.rightbarTab.set(panel);
  }

  /** After choosing an insert target, show the Elements insert column. */
  protected focusRightbarInsertPanel() {
    this.rightbarPrimaryTab.set('elements');
    this.rightbarTab.set('options');
  }

  protected isKeySlotPageIndex(pageIndex: number): boolean {
    return pageIndex >= 0 && pageIndex < this.keySlotPageCount();
  }

  protected isKeySlotPageAvailable(pageIndex: number): boolean {
    return pageIndex >= 0 && pageIndex < this.pageCount();
  }

  private ensureKeySlotSectionOverrides() {
    // Prime fixed + custom titles into the sidebar section resolver.
    // This makes the left nav deterministic even when PDF heading detection is inconsistent.
    const fixedTitles = PdfEditorComponent.fixedKeySlots.map((s) => s.title);
    const customSlots = this.customKeySlots();

    const overrides: Record<number, { title: string; type: SidebarSectionType }> = {};
    for (let i = 0; i < fixedTitles.length; i++) {
      if (i >= this.pageCount()) break;
      overrides[i] = { title: fixedTitles[i]!, type: 'section' };
    }
    for (let i = 0; i < customSlots.length; i++) {
      const pageIndex = fixedTitles.length + i;
      if (pageIndex >= this.pageCount()) break;
      const title = this.sanitizeSidebarTitle(customSlots[i]?.title ?? '');
      if (!title) continue;
      overrides[pageIndex] = { title, type: 'section' };
    }

    this.removedSectionsByPage.update((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      const next = { ...prev };
      const max = Math.min(this.pageCount(), PdfEditorComponent.fixedKeySlots.length + customSlots.length);
      for (let i = 0; i < max; i++) delete next[i];
      return next;
    });

    this.sectionOverridesByPage.update((prev) => ({ ...prev, ...overrides }));
  }

  protected async addCustomKeySlot() {
    if (this.readonlyMode()) return;
    if (this.isLoading() || this.isSaving()) return;

    const titleInput = (prompt('Custom slot title', `Custom ${this.customKeySlots().length + 1}`) ?? '').trim();
    if (!titleInput) return;

    const insertAfterIndex = this.keySlotPageCount() - 1; // Insert at the end of current key slots
    await this.addBlankPageAfter(Math.max(0, insertAfterIndex));
    this.customKeySlots.update((prev) => [
      ...prev,
      { id: `custom_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 7)}`, title: titleInput, kind: 'custom' }
    ]);
    this.ensureKeySlotSectionOverrides();
  }

  protected renameCustomKeySlot(customIndex: number) {
    if (this.readonlyMode()) return;
    if (this.isLoading() || this.isSaving()) return;
    const slots = this.customKeySlots();
    const slot = slots[customIndex];
    if (!slot) return;

    const titleInput = (prompt('Rename custom slot', slot.title) ?? '').trim();
    if (!titleInput) return;

    this.customKeySlots.update((prev) => {
      const next = prev.slice();
      const it = next[customIndex];
      if (!it) return prev;
      next[customIndex] = { ...it, title: titleInput };
      return next;
    });
    this.ensureKeySlotSectionOverrides();
  }

  protected onCustomKeySlotDragStart(customIndex: number, ev: DragEvent) {
    if (this.isLoading() || this.isSaving()) {
      ev.preventDefault();
      return;
    }
    const dt = ev.dataTransfer;
    if (!dt) return;
    dt.effectAllowed = 'move';
    dt.setData('text/plain', String(customIndex));
    this.keySlotDragFromCustomIndex.set(customIndex);
  }

  protected onCustomKeySlotDragOver(ev: DragEvent) {
    ev.preventDefault();
    try {
      ev.dataTransfer!.dropEffect = 'move';
    } catch {
      // ignore
    }
  }

  protected async onCustomKeySlotDrop(targetCustomIndex: number, ev: DragEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    const from = this.keySlotDragFromCustomIndex();
    this.keySlotDragFromCustomIndex.set(null);
    if (from === null) return;
    if (from === targetCustomIndex) return;

    const customCount = this.customKeySlots().length;
    if (customCount <= 1) return;

    const prevCustomSlots = this.customKeySlots();
    // Compute moved permutation within the custom slots array.
    const perm = (() => {
      const order = Array.from({ length: customCount }, (_, i) => i);
      const fi = clamp(from, 0, customCount - 1);
      const ti = clamp(targetCustomIndex, 0, customCount - 1);
      if (fi === ti) return null;
      const [moved] = order.splice(fi, 1);
      order.splice(ti, 0, moved);
      return order; // newCustomPos -> oldCustomPos
    })();
    if (!perm) return;

    const nextCustomSlots = perm.map((oldIdx) => prevCustomSlots[oldIdx]!).filter(Boolean);
    const fixedCount = PdfEditorComponent.fixedKeySlots.length;
    const reorder = Array.from({ length: this.pageCount() }, (_, i) => i);
    for (let newCustomPos = 0; newCustomPos < customCount; newCustomPos++) {
      const oldCustomPos = perm[newCustomPos]!;
      reorder[fixedCount + newCustomPos] = fixedCount + oldCustomPos;
    }

    // Update UI state immediately; the actual page reorder happens on the PDF.
    this.customKeySlots.set(nextCustomSlots as KeySlot[]);
    await this.reorderPagesInDocumentByOrder(reorder);
    this.ensureKeySlotSectionOverrides();
  }

  protected sidebarSectionLabelForPage(pageIndex: number): string {
    const meta = this.sidebarSectionByPage()[pageIndex];
    return meta ? meta.title : `Page ${pageIndex + 1}`;
  }

  /** Slide thumbnail overlay: slide index plus section name (or `Page n` when unknown). */
  protected sidebarSectionDisplayLine(pageIndex: number): string {
    const n = pageIndex + 1;
    const label = this.sidebarSectionLabelForPage(pageIndex);
    if (label === `Page ${n}`) return label;
    return `${n}. ${label}`;
  }

  protected sidebarSectionTypeForPage(pageIndex: number): SidebarSectionType | null {
    return this.sidebarSectionByPage()[pageIndex]?.type ?? null;
  }

  protected isSidebarSectionStart(pageIndex: number): boolean {
    const byPage = this.sidebarSectionByPage();
    const current = byPage[pageIndex];
    if (!current) return false;
    if (pageIndex <= 0) return true;
    const previous = byPage[pageIndex - 1];
    if (!previous) return true;
    return previous.title !== current.title || previous.type !== current.type;
  }

  protected setRightbarTab(tab: 'options' | 'settings' | 'typography' | 'assets' | 'versions') {
    this.rightbarTab.set(tab);
  }

  private hydrateReusableAssetsFromStorage() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(PdfEditorComponent.reusableAssetsStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as ReusableAsset[];
      if (!Array.isArray(parsed)) return;
      const next = parsed
        .filter(
          (a) =>
            a &&
            typeof a.id === 'string' &&
            a.kind === 'template' &&
            typeof a.imageSrc === 'string' &&
            a.imageSrc.length > 0
        )
        .slice(0, PdfEditorComponent.maxPersistedReusableAssets);
      if (next.length) this.reusableAssets.set(next);
    } catch {
      // ignore
    }
  }

  private persistReusableAssetsToStorage() {
    if (typeof localStorage === 'undefined') return;
    const list = this.reusableAssets();
    const serializable = list
      .filter((a) => a.kind === 'template' && typeof a.imageSrc === 'string' && a.imageSrc.length > 0)
      .slice(0, PdfEditorComponent.maxPersistedReusableAssets);
    try {
      localStorage.setItem(PdfEditorComponent.reusableAssetsStorageKey, JSON.stringify(serializable));
    } catch {
      // ignore
    }
  }

  protected async refreshCrmAssetLibrary() {
    const seq = ++this.crmAssetFetchSeq;
    this.assetLibraryLoading.set(true);
    this.assetLibraryError.set(null);
    try {
      const data = await this.api.getCrmAssetLibrary();
      if (seq !== this.crmAssetFetchSeq) return;
      this.crmLibraryConfigured.set(data.crmConfigured);
      this.crmAssetCategories.set(data.categories);
      this.crmAssetItems.set(data.assets);
    } catch (e) {
      if (seq !== this.crmAssetFetchSeq) return;
      this.assetLibraryError.set(e instanceof Error ? e.message : 'Failed to load asset library.');
    } finally {
      if (seq === this.crmAssetFetchSeq) this.assetLibraryLoading.set(false);
    }
  }

  protected setAssetLibraryCategory(categoryId: string | null) {
    this.assetLibraryCategoryId.set(categoryId);
  }

  protected assetKindDisplay(kind: string): string {
    if (kind === 'image') return 'Image';
    if (kind === 'video') return 'Video';
    if (kind === 'template') return 'Template';
    return 'Other';
  }

  protected insertFromAssetLibraryRow(row: AssetLibraryRow, ev?: Event) {
    if (row.rowKind === 'local') {
      this.placeReusableAsset(row.asset.id, ev);
      return;
    }
    this.insertCrmLibraryItem(row.item, ev);
  }

  private static readonly assetLibraryDragMime = 'application/x-avyro-asset-library';

  /** Normalize a URL for `<video src>`: absolute http(s), blob, data, or protocol-relative. */
  private normalizeVideoWidgetSrc(src: string | undefined | null): string | null {
    if (src == null) return null;
    const s = String(src).trim();
    if (!s) return null;
    if (s.startsWith('//')) return `https:${s}`;
    const low = s.toLowerCase();
    if (
      s.startsWith('http://') ||
      s.startsWith('https://') ||
      s.startsWith('blob:') ||
      low.startsWith('data:video/') ||
      low.startsWith('data:application/octet-stream')
    ) {
      return s;
    }
    return null;
  }

  protected onAssetLibraryRowDragStart(row: AssetLibraryRow, ev: DragEvent) {
    if (this.pageCount() === 0 || this.isLoading()) {
      ev.preventDefault();
      return;
    }
    const dt = ev.dataTransfer;
    if (!dt) return;
    const payload =
      row.rowKind === 'local'
        ? ({ v: 1 as const, rowKind: 'local' as const, id: row.asset.id } as const)
        : ({ v: 1 as const, rowKind: 'crm' as const, id: row.item.id } as const);
    const json = JSON.stringify(payload);
    dt.setData(PdfEditorComponent.assetLibraryDragMime, json);
    dt.setData('text/plain', json);
    dt.effectAllowed = 'copy';
  }

  /**
   * After choosing an asset from the library (including drag onto the page), arm the same
   * click-to-place flow as the Insert buttons — the next click on the PDF drops the element.
   */
  private prepareAssetLibraryRowPlacement(row: AssetLibraryRow) {
    this.errorText.set(null);
    this.cancelInsertWidgetMode();
    this.tool.set('text');
    if (row.rowKind === 'local' && row.asset.imageSrc) {
      this.insertWidgetPending.set({ kind: 'table' });
      this.focusRightbarInsertPanel();
      return;
    }
    if (row.rowKind === 'crm' && (row.item.kind === 'template' || row.item.kind === 'image')) {
      this.insertWidgetPending.set({ kind: 'table' });
      this.focusRightbarInsertPanel();
      return;
    }
    this.errorText.set('Only template assets are supported for insertion.');
  }

  private parseAssetLibraryDropPayload(raw: string): { v: 1; rowKind: 'local' | 'crm'; id: string } | null {
    const t = raw.trim();
    if (!t.startsWith('{')) return null;
    try {
      const o = JSON.parse(t) as { v?: unknown; rowKind?: unknown; id?: unknown };
      if (o?.v !== 1) return null;
      if (o.rowKind !== 'local' && o.rowKind !== 'crm') return null;
      if (typeof o.id !== 'string' || !o.id) return null;
      return { v: 1, rowKind: o.rowKind, id: o.id };
    } catch {
      return null;
    }
  }

  private resolveAssetLibraryRowFromPayload(
    payload: { v: 1; rowKind: 'local' | 'crm'; id: string }
  ): AssetLibraryRow | null {
    if (payload.rowKind === 'local') {
      const asset = this.reusableAssets().find((a) => a.id === payload.id);
      return asset ? { rowKind: 'local', asset } : null;
    }
    const item = this.crmAssetItems().find((i) => i.id === payload.id);
    return item ? { rowKind: 'crm', item } : null;
  }

  private insertCrmLibraryItem(item: CrmAssetLibraryItem, ev?: Event) {
    ev?.preventDefault();
    ev?.stopPropagation();
    this.errorText.set(null);
    this.cancelInsertWidgetMode();
    this.tool.set('text');
    if (item.kind === 'template' || item.kind === 'image') {
      this.insertWidgetPending.set({ kind: 'table' });
      this.focusRightbarInsertPanel();
      return;
    }
    this.errorText.set('Only template assets are supported for insertion.');
  }

  protected formatVersionTimestamp(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  protected async openSharePanel() {
    this.sharePanelOpen.set(true);
    this.shareEmailInput.set('');
    const id = this.docId();
    if (!id) return;
    this.errorText.set(null);
    try {
      const rec = await this.api.getShareForProposal(id);
      if (rec?.linkToken) {
        const origin = typeof window !== 'undefined' ? window.location.origin : '';
        this.shareAccessType.set(rec.accessType);
        this.shareUsers.set(rec.users ?? []);
        this.shareUrl.set(`${origin}/edit/${encodeURIComponent(id)}?share=${encodeURIComponent(rec.linkToken)}`);
        this.lastShareRecord.set({
          sharedBy: rec.sharedBy ?? '',
          sharedAt: Number(rec.updatedAt ?? rec.createdAt ?? Date.now())
        });
      } else {
        this.shareUrl.set('');
        this.shareUsers.set([]);
        this.lastShareRecord.set(null);
      }
    } catch {
      // Panel stays usable; link generation and add-user still attempt API calls.
    }
  }

  protected closeSharePanel() {
    this.sharePanelOpen.set(false);
    this.shareEmailInput.set('');
  }

  protected async generateShareLink() {
    const proposalId = this.docId();
    if (!proposalId) return;
    this.errorText.set(null);
    this.shareBusy.set(true);
    try {
      const proposal = this.proposalDetails();
      const derivedFrom =
        proposal?.derivedFrom && proposal.derivedFromDetails
          ? { id: proposal.derivedFromDetails.id, name: proposal.derivedFromDetails.name }
          : null;
      const shared = await this.api.generateShareLink({
        proposalId,
        accessType: this.shareAccessType(),
        sharedBy: this.getEditedBy(),
        derivedFrom
      });
      this.shareUrl.set(shared.url);
      this.shareUsers.set(shared.users ?? []);
      this.lastShareRecord.set({
        sharedBy: shared.sharedBy ?? this.getEditedBy(),
        sharedAt: Number(shared.updatedAt ?? Date.now())
      });
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to generate share link.');
    } finally {
      this.shareBusy.set(false);
    }
  }

  protected async addShareUser() {
    const proposalId = this.docId();
    const email = this.shareEmailInput().trim();
    if (!proposalId || !email) return;
    this.errorText.set(null);
    this.shareBusy.set(true);
    try {
      const updated = await this.api.addShareUser({
        proposalId,
        email,
        role: this.shareRoleInput()
      });
      this.shareUsers.set(updated.users ?? []);
      this.shareEmailInput.set('');
      if (updated.linkToken && typeof window !== 'undefined') {
        this.shareUrl.set(
          `${window.location.origin}/edit/${encodeURIComponent(proposalId)}?share=${encodeURIComponent(updated.linkToken)}`
        );
      }
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to add share user.');
    } finally {
      this.shareBusy.set(false);
    }
  }

  protected rejectionLabel(): string {
    const r = this.rejection();
    if (!r) return 'Not rejected';
    return r.level === 'client' ? 'Client rejected' : 'Internally rejected';
  }

  protected async rejectProposal(level: RejectionLevel) {
    const id = this.docId();
    if (!id) return;
    this.errorText.set(null);
    this.rejectionBusy.set(true);
    try {
      const rec = await this.api.rejectProposal(id, {
        level,
        reason: this.rejectionReasonInput().trim(),
        rejectedBy: this.getEditedBy()
      });
      this.rejection.set(rec);
      this.showSlideToast(level === 'client' ? 'Marked as client rejected' : 'Marked as internally rejected');
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to reject proposal.');
    } finally {
      this.rejectionBusy.set(false);
    }
  }

  protected async copyShareLink() {
    const value = this.shareUrl().trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      this.showSlideToast('Share link copied');
    } catch {
      this.errorText.set('Unable to copy link.');
    }
  }

  protected formatTimestamp(ts: number): string {
    if (!Number.isFinite(ts)) return '-';
    return new Date(ts).toLocaleString();
  }

  protected derivedFromLabel(): string {
    const details = this.proposalDetails()?.derivedFromDetails;
    if (!details) return '';
    return details.name || 'Original proposal not available';
  }

  protected canOpenDerivedProposal(): boolean {
    const details = this.proposalDetails()?.derivedFromDetails;
    return Boolean(details && !details.isDeleted && details.hasAccess !== false);
  }

  protected async openDerivedProposalReadOnly(ev: Event) {
    ev.preventDefault();
    if (!this.canOpenDerivedProposal()) return;
    const id = this.proposalDetails()?.derivedFromDetails?.id;
    if (!id) return;
    await this.router.navigate(['/edit', id], { queryParams: { readonly: '1' } });
  }

  private getEditedBy(): string {
    try {
      const stored = localStorage.getItem('avyro.editorName');
      return stored && stored.trim() ? stored.trim() : 'Unknown User';
    } catch {
      return 'Unknown User';
    }
  }

  protected updateGlobalTypography(
    section: keyof GlobalTypographySettings,
    patch: Partial<GlobalTypographySection>
  ) {
    this.globalTypography.update((prev) => ({
      ...prev,
      [section]: { ...prev[section], ...patch }
    }));
    void this.applyGlobalTypographyToDocument();
  }

  protected globalTypographyColorPickerValue(section: keyof GlobalTypographySettings): string {
    const raw = this.globalTypography()[section].color;
    return cssColorToHex6ForColorInput(raw) ?? DEFAULT_GLOBAL_TYPOGRAPHY[section].color;
  }

  private blockSectionForDetected(block: DetectedBlock): keyof GlobalTypographySettings {
    if (block.kind === 'heading') return 'heading';
    if (block.kind === 'list') return 'subheading';
    return 'body';
  }

  private styleToFontStyle(style: GlobalTypographySection): FontStyle {
    if (style.bold && style.italic) return 'boldItalic';
    if (style.bold) return 'bold';
    if (style.italic) return 'italic';
    return 'regular';
  }

  private async detectBlocksForPage(pageIndex: number): Promise<DetectedBlock[]> {
    if (!this.pdfDoc) return [];
    const page = await this.pdfDoc.getPage(pageIndex + 1);
    const cssViewport = this.getCssViewportForPdfPage(page);
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
        const w = Math.max(1, Number(it.width ?? 0) * cssViewport.scale);
        const h = Math.max(1, Math.hypot(Number(tx[2] ?? 0), Number(tx[3] ?? 0)) * cssViewport.scale);
        const y = yBottom - h;
        const fontName = String(it.fontName ?? '');
        items.push({
          x,
          y,
          w,
          h,
          text: str,
          fontSize: Math.max(6, h),
          fontStyle: inferFontStyleFromPdfJsStyle(styles[fontName] ?? { fontName }),
          fontFamily: inferFontFamilyFromPdfJsStyle(styles[fontName] ?? { fontName })
        });
      }
      const blocks = this.groupDetectedTextIntoBlocks(items);
      this.detectedTextByPage.update((prev) => ({ ...prev, [pageIndex]: items }));
      this.detectedBlocksByPage.update((prev) => ({ ...prev, [pageIndex]: blocks }));
      return blocks;
    } catch {
      return [];
    }
  }

  protected async applyGlobalTypographyToDocument() {
    if (!this.pdfDoc || this.pageCount() <= 0) return;
    const typography = this.globalTypography();
    const next = this.cloneEdits(this.editsByPage());
    this.beginHistoryStep();

    for (let pageIndex = 0; pageIndex < this.pageCount(); pageIndex++) {
      const blocks = await this.detectBlocksForPage(pageIndex);
      const existing = next[pageIndex] ?? {
        viewportWidth: 0,
        viewportHeight: 0,
        ink: [],
        text: [],
        images: [],
        replaces: []
      };
      const replaces = this.mergeGlobalTypographyReplacesForPage(existing.replaces ?? [], blocks, typography);

      next[pageIndex] = { ...existing, replaces };
    }

    this.editsByPage.set(next);
    await this.renderActivePage();
  }

  /** Rebuilds auto-applied typography masks so repeated global font changes do not stack duplicates. */
  private mergeGlobalTypographyReplacesForPage(
    existing: TextReplace[],
    blocks: DetectedBlock[],
    typography: GlobalTypographySettings
  ): TextReplace[] {
    const kept: TextReplace[] = [];
    for (const r of existing) {
      if (r.source === 'globalTypography') continue;
      if (this.shouldDiscardStaleTypographyMaskReplace(r, blocks)) continue;
      kept.push(r);
    }

    const out = [...kept];
    for (const block of blocks) {
      if (!block.text.trim()) continue;
      if (out.some((r) => this.blockPrimarilyCoveredByReplace(block, r))) continue;
      const section = typography[this.blockSectionForDetected(block)];
      const { innerW, innerH } = this.globalTypographyMaskSize(block, section);
      const padX = Math.max(2, Math.round(section.size * (section.bold ? 0.16 : 0.11)));
      const padY = Math.max(2, Math.round(section.size * (section.italic ? 0.14 : 0.1)));
      const x = block.x - padX;
      const y = block.y - padY;
      const w = Math.max(1, innerW + 2 * padX);
      const h = Math.max(1, innerH + 2 * padY);
      out.push({
        x,
        y,
        w,
        h,
        textX: block.x,
        textY: block.y,
        textWrapWidth: Math.max(1, innerW),
        oldText: block.text,
        newText: block.text,
        maskMode: 'color',
        bgColor: '#ffffff',
        color: section.color,
        fontSize: section.size,
        fontStyle: this.styleToFontStyle(section),
        fontFamily: section.fontFamily,
        source: 'globalTypography'
      });
    }
    return out;
  }

  private globalTypographyMaskSize(
    block: DetectedBlock,
    section: GlobalTypographySection
  ): { innerW: number; innerH: number } {
    const lineCount = Math.max(1, block.text.split('\n').length);
    const lh = Math.max(1, Math.round(section.size * 1.2));
    const minH = lineCount * lh + Math.round(section.size * 0.35);
    const innerH = Math.max(block.h, minH, Math.round(section.size * 1.45));
    const fontRatio = section.size / Math.max(6, block.fontSize);
    const widthBoost = section.bold ? 1.12 : 1.0;
    const innerW = Math.max(block.w, Math.round(block.w * Math.max(1, fontRatio * 1.14 * widthBoost)));
    return { innerW: Math.max(1, innerW), innerH: Math.max(1, innerH) };
  }

  private blockPrimarilyCoveredByReplace(block: DetectedBlock, r: TextReplace): boolean {
    const left = Math.max(block.x, r.x);
    const top = Math.max(block.y, r.y);
    const right = Math.min(block.x + block.w, r.x + r.w);
    const bottom = Math.min(block.y + block.h, r.y + r.h);
    const overlapArea = Math.max(0, right - left) * Math.max(0, bottom - top);
    const blockArea = Math.max(1, block.w * block.h);
    return overlapArea / blockArea >= 0.48;
  }

  /**
   * Sidebar section titles are derived from PDF text detection, but in-place edits are stored as
   * `TextReplace` masks + `newText` (the PDF text layer is not rewritten). Merge those into a
   * copy of detected blocks so the left nav tracks what the user actually sees.
   */
  private detectedBlocksWithTextReplacesApplied(blocks: DetectedBlock[], replaces: TextReplace[]): DetectedBlock[] {
    if (!blocks.length || !replaces.length) return blocks;
    const out = blocks.map((b) => ({ ...b }));
    for (const r of replaces) {
      if (r.source === 'mediaErase') continue;
      for (let i = 0; i < out.length; i++) {
        const b = out[i]!;
        if (!this.blockPrimarilyCoveredByReplace(b, r)) continue;
        out[i] = { ...b, text: r.newText };
      }
    }
    return out;
  }

  /**
   * Removes identity mask replaces (no text change) that belong to a prior typography pass,
   * including legacy saves with no `source`, so re-applying global typography does not stack duplicates.
   */
  private shouldDiscardStaleTypographyMaskReplace(r: TextReplace, blocks: DetectedBlock[]): boolean {
    if (r.source === 'textEdit' || r.source === 'mediaErase') return false;
    if (r.newText !== r.oldText) return false;
    if (r.maskMode !== 'color') return false;
    return blocks.some(
      (b) => b.text.trim() === r.oldText.trim() && this.typographyMaskReplaceMatchesBlock(r, b)
    );
  }

  private typographyMaskReplaceMatchesBlock(r: TextReplace, b: DetectedBlock): boolean {
    if (this.isSameReplaceRegion(r, { x: b.x, y: b.y, w: b.w, h: b.h })) return true;
    const left = Math.max(b.x, r.x);
    const top = Math.max(b.y, r.y);
    const right = Math.min(b.x + b.w, r.x + r.w);
    const bottom = Math.min(b.y + b.h, r.y + r.h);
    const overlapArea = Math.max(0, right - left) * Math.max(0, bottom - top);
    if (overlapArea <= 0) return false;
    const blockArea = Math.max(1, b.w * b.h);
    const replaceArea = Math.max(1, r.w * r.h);
    return overlapArea / blockArea >= 0.28 || overlapArea / replaceArea >= 0.28;
  }

  protected furnitureAlignOptions: FurnitureAlignment[] = ['left', 'center', 'right'];
  protected pageNumberFormatOptions: PageNumberFormat[] = ['1', '1 / N', 'Page 1 of N'];
  protected pageNumberPositionOptions: PageNumberPosition[] = [
    'header-left',
    'header-right',
    'footer-left',
    'footer-center',
    'footer-right'
  ];

  protected updateFurniture<K extends keyof PageFurniture>(key: K, value: PageFurniture[K]) {
    this.pageFurniture.update((prev) => ({ ...prev, [key]: value }));
  }

  protected updateProposalTitleFurniture(value: unknown) {
    this.proposalTitleDraft.set(this.coerceFurnitureTextValue(value));
  }

  protected updateClientNameFurniture(value: unknown) {
    this.clientNameDraft.set(this.coerceFurnitureTextValue(value));
  }

  protected saveDynamicFields() {
    if (!this.hasUnsavedDynamicFields()) return;
    this.pageFurniture.update((prev) => ({
      ...prev,
      proposalTitle: this.proposalTitleDraft(),
      clientName: this.clientNameDraft()
    }));
    this.showSlideToast('Dynamic fields saved');
  }

  protected updateHeaderFurniture(patch: Partial<PageFurniture['header']>) {
    this.pageFurniture.update((prev) => ({ ...prev, header: { ...prev.header, ...patch } }));
  }

  protected updateFooterFurniture(patch: Partial<PageFurniture['footer']>) {
    this.pageFurniture.update((prev) => ({ ...prev, footer: { ...prev.footer, ...patch } }));
  }

  protected updatePageNumberFurniture(patch: Partial<PageFurniture['pageNumber']>) {
    this.pageFurniture.update((prev) => ({
      ...prev,
      pageNumber: {
        ...prev.pageNumber,
        ...patch,
        startFrom: Math.max(1, Number(patch.startFrom ?? prev.pageNumber.startFrom ?? 1))
      }
    }));
  }

  protected updateLogoFurniture(patch: Partial<PageFurniture['logo']>) {
    this.pageFurniture.update((prev) => ({ ...prev, logo: { ...prev.logo, ...patch } }));
  }

  protected openLogoPicker(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    const input = this.furnitureLogoFile?.nativeElement;
    if (!input) return;
    input.value = '';
    input.click();
  }

  protected async onFurnitureLogoPicked(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|gif|svg\+xml)$/i.test(file.type)) {
      this.errorText.set('Please select a valid logo image.');
      return;
    }
    try {
      const dataUrl = await this.readFileAsDataUrl(file);
      const img = await this.loadHtmlImage(dataUrl);
      this.logoNaturalAspect = Math.max(0.1, img.width / Math.max(1, img.height));
      this.pageFurniture.update((prev) => {
        const width = Math.max(24, prev.logo.width || 96);
        const nextHeight = prev.logo.keepAspectRatio
          ? Math.max(16, Math.round(width / this.logoNaturalAspect))
          : prev.logo.height;
        return {
          ...prev,
          logo: {
            ...prev.logo,
            url: dataUrl,
            visible: true,
            width,
            height: nextHeight
          }
        };
      });
      this.errorText.set(null);
    } catch {
      this.errorText.set('Failed to load logo image.');
    }
  }

  protected removeLogo() {
    this.pageFurniture.update((prev) => ({ ...prev, logo: { ...prev.logo, url: '', visible: false, linkUrl: '' } }));
  }

  protected onLogoWidthInput(widthRaw: string) {
    const width = Math.max(24, Number(widthRaw) || 24);
    this.pageFurniture.update((prev) => {
      const height = prev.logo.keepAspectRatio
        ? Math.max(16, Math.round(width / Math.max(0.1, this.logoNaturalAspect)))
        : prev.logo.height;
      return { ...prev, logo: { ...prev.logo, width, height } };
    });
  }

  protected onLogoHeightInput(heightRaw: string) {
    const height = Math.max(16, Number(heightRaw) || 16);
    this.pageFurniture.update((prev) => {
      if (!prev.logo.keepAspectRatio) return { ...prev, logo: { ...prev.logo, height } };
      const width = Math.max(24, Math.round(height * Math.max(0.1, this.logoNaturalAspect)));
      return { ...prev, logo: { ...prev.logo, width, height } };
    });
  }

  protected furnitureText(content: string, pageIndex: number): string {
    const f = this.pageFurniture();
    const renderedPage = f.pageNumber.startFrom + pageIndex;
    const total = this.pageCount();
    const proposalTitle = f.proposalTitle || this.derivedProposalTitle();
    return (content ?? '')
      .replace(/\{\{\s*(proposalTitle|projectName)\s*\}\}/g, proposalTitle)
      .replace(/\{\{\s*clientName\s*\}\}/g, f.clientName || '-')
      .replace(/\{\{\s*page\s*\}\}/g, String(renderedPage))
      .replace(/\{\{\s*totalPages\s*\}\}/g, String(total))
      .replace(/\{\{\s*date\s*\}\}/g, new Date().toLocaleDateString());
  }

  protected pageNumberLabel(pageIndex: number): string {
    const p = this.pageFurniture().pageNumber;
    if (!p.visible) return '';
    const n = p.startFrom + pageIndex;
    const total = this.pageCount();
    if (p.format === '1') return String(n);
    if (p.format === '1 / N') return `${n} / ${total}`;
    return `Page ${n} of ${total}`;
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

  protected onWidgetDragStart(kind: WidgetKind, ev: DragEvent) {
    try {
      const dt = ev.dataTransfer;
      if (!dt) return;
      dt.setData('application/x-avyro-widget-kind', kind);
      // Avoid putting the raw kind (e.g. "text") on text/plain — some environments surface
      // that as a bogus clipboard/plain payload; drops still read application/x-avyro-widget-kind first.
      dt.setData('text/plain', '');
      dt.effectAllowed = 'copy';
    } catch {
      // ignore
    }
  }

  /** Shared by Insert → Text and drag-drop of the text chip: next click on the canvas starts a text draft. */
  private armPlacedTextInsertMode() {
    if (this.isTextPlacing() && !this.activeTextDraftGesture) this.commitTextDraft();
    this.flushInlineWidgetTextEditors(this.activePageIndex());
    this.cancelInsertWidgetMode();
    this.errorText.set(null);
    this.textFeatureEnabled.set(true);
    void this.renderActivePage().finally(() => this.cdr.markForCheck());
    this.tool.set('text');
  }

  protected onInsertWidgetClick(kind: WidgetKind, ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();

    if (kind === 'text') {
      this.armPlacedTextInsertMode();
      return;
    }
    this.cancelInsertWidgetMode();
    this.tool.set('text');
    this.insertWidgetPending.set({ kind });
  }

  protected placeReusableAsset(assetId: string, ev?: Event) {
    ev?.preventDefault();
    ev?.stopPropagation();
    const asset = this.reusableAssets().find((a) => a.id === assetId);
    if (!asset) return;
    this.errorText.set(null);
    this.cancelInsertWidgetMode();
    this.tool.set('text');
    if (asset.kind === 'template' && asset.imageSrc) {
      this.insertWidgetPending.set({ kind: 'table' });
      this.focusRightbarInsertPanel();
      return;
    }
    this.errorText.set('Only template assets are supported for insertion.');
  }

  protected insertWidgetModeHint(): string {
    const p = this.insertWidgetPending();
    if (!p) return '';
    return p.kind === 'table' ? 'Click on the page to place the table.' : 'Click on the page to place text.';
  }

  protected cancelInsertWidgetMode() {
    this.insertWidgetPending.set(null);
    this.isInserting.set(false);
  }

  private addWidgetAtPoint(
    pageIndex: number,
    kind: WidgetKind,
    centerX: number,
    centerY: number
  ) {
    const { overlay } = this.getCanvasPair(pageIndex);
    if (!overlay) return;
    if (kind === 'text' && !this.textFeatureEnabled()) {
      this.errorText.set('Turn on Text (PDF text editing) in the sidebar to add text boxes.');
      return;
    }

    const defaults: Record<WidgetKind, { w: number; h: number }> = {
      table: { w: 400, h: 220 },
      text: { w: 300, h: 160 }
    };
    const d = defaults[kind];
    const { w: cw, h: ch } = this.overlayNominalCssSize(overlay);

    const id = `w_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
    const widget: Widget = {
      id,
      kind,
      x: clamp(centerX - d.w / 2, 0, Math.max(0, cw - d.w)),
      y: clamp(centerY - d.h / 2, 0, Math.max(0, ch - d.h)),
      w: d.w,
      h: d.h
    };

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
    // Text widgets only mount `.widget__editor` while `editingWidgetId` matches; enter edit mode immediately.
    if (kind === 'text' && this.textFeatureEnabled()) {
      this.editingWidgetId.set(id);
      queueMicrotask(() => this.focusWidgetEditor(id));
    }
    if (kind === 'table') {
      queueMicrotask(() => {
        const el = document.querySelector<HTMLInputElement>(
          `[data-widget-id="${id}"] .widget__cell[data-r="0"][data-c="0"]`
        );
        el?.focus?.();
      });
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

    if (w?.kind === 'text') {
      this.syncToolbarFromTextStyle({
        color: this.textColor(),
        fontSize: this.textSize(),
        fontStyle: this.textStyle(),
        fontFamily: this.textFamily(),
        bgEnabled: this.textBgEnabled(),
        bgColor: this.textBgColor()
      });
    }
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
    this.markEditorContentChanged();
  }

  /**
   * Overlay/canvas can take focus without a reliable textarea blur; sync inline editors
   * (text box widgets, layered text, tables) into signals before other hit-handling runs.
   */
  private flushInlineWidgetTextEditors(pageIndex: number) {
    const wid = this.editingWidgetId();
    if (!wid) return;
    const w = this.getWidget(pageIndex, wid);
    if (!w) return;

    if (w.kind === 'text') {
      if (!this.textFeatureEnabled()) {
        this.stopEditingWidget(wid);
        return;
      }
      const ta = document.querySelector<HTMLTextAreaElement>(
        `[data-widget-id="${wid}"] textarea.widget__text.widget__editor`
      );
      if (ta) this.updateTextWidget(pageIndex, wid, ta.value);
      this.persistEditorStateNow();
      this.stopEditingWidget(wid);
      return;
    }

    if (w.kind === 'table') {
      const root = document.querySelector(`[data-widget-id="${wid}"]`);
      if (root) {
        for (const input of root.querySelectorAll<HTMLInputElement>('input.widget__cell.widget__editor')) {
          const r = Number(input.dataset['r']);
          const c = Number(input.dataset['c']);
          if (Number.isFinite(r) && Number.isFinite(c)) {
            this.updateTableCell(pageIndex, wid, r, c, input.value);
          }
        }
      }
      this.persistEditorStateNow();
      this.stopEditingWidget(wid);
    }
  }

  /** Flush textarea value then exit edit (blur may run before last ngModel tick). */
  protected onTextWidgetEditorBlur(pageIndex: number, widgetId: string, ev: FocusEvent) {
    const ta = ev.target as HTMLTextAreaElement | null;
    if (ta && this.textFeatureEnabled()) {
      this.updateTextWidget(pageIndex, widgetId, ta.value);
      this.persistEditorStateNow();
    }
    this.stopEditingWidget(widgetId);
  }

  protected onTextWidgetEditorEscape(pageIndex: number, widgetId: string, ev: Event) {
    (ev as KeyboardEvent).stopPropagation();
    const ta = ev.target as HTMLTextAreaElement | null;
    if (ta && this.textFeatureEnabled()) {
      this.updateTextWidget(pageIndex, widgetId, ta.value);
      this.persistEditorStateNow();
    }
    this.stopEditingWidget(widgetId);
  }

  /** Enter commits and leaves edit; Shift+Enter inserts a newline. */
  protected onTextWidgetEditorEnter(pageIndex: number, widgetId: string, ev: Event) {
    const ke = ev as KeyboardEvent;
    if (ke.key !== 'Enter' || ke.shiftKey) return;
    ke.preventDefault();
    ke.stopPropagation();
    const ta = ke.target as HTMLTextAreaElement | null;
    if (ta && this.textFeatureEnabled()) {
      this.updateTextWidget(pageIndex, widgetId, ta.value);
      this.persistEditorStateNow();
    }
    this.stopEditingWidget(widgetId);
  }

  /** Empty text widget: full hit-target so clicks don’t fall through to widget drag; + pill stays hover-only. */
  protected onTextWidgetEmptyActivate(widgetId: string, ev: Event) {
    if (!this.textFeatureEnabled()) return;
    ev.preventDefault?.();
    this.startEditingWidget(widgetId, ev);
  }

  private scheduleRemoteEditorStateSave() {
    if (this.editorRemoteSaveTimer !== null) clearTimeout(this.editorRemoteSaveTimer);
    this.editorRemoteSaveTimer = setTimeout(() => {
      this.editorRemoteSaveTimer = null;
      void this.flushRemoteEditorStateImmediate();
    }, 350);
  }

  private async flushRemoteEditorStateImmediate() {
    if (this.editorRemoteSaveTimer !== null) {
      clearTimeout(this.editorRemoteSaveTimer);
      this.editorRemoteSaveTimer = null;
    }
    const id = this.docId();
    if (!id || this.isLoading() || this.readonlyMode()) return;
    try {
      await this.persistEditorStateToRemote(id, this.editsByPage(), this.widgetsByPage(), this.fileName());
    } catch {
      // non-fatal; user can retry via Save
    }
  }

  private scheduleEditorStatePersist() {
    this.scheduleRemoteEditorStateSave();
  }

  private cancelEditorStatePersist() {
    if (this.editorRemoteSaveTimer !== null) {
      clearTimeout(this.editorRemoteSaveTimer);
      this.editorRemoteSaveTimer = null;
    }
  }

  private persistEditorStateNow() {
    void this.flushRemoteEditorStateImmediate();
  }

  private markEditorContentChanged() {
    if (!this.docId() || this.isLoading()) return;
    this.scheduleEditorStatePersist();
    this.scheduleAutoVersionSave();
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
    const { w: maxW, h: maxH } = this.overlayNominalCssSize(overlay);
    this.widgetsByPage.update((prev) => {
      const cur = prev[pageIndex] ?? [];
      const idx = cur.findIndex((x) => x.id === widgetId);
      if (idx < 0) return prev;
      const next = cur.slice();
      const it = next[idx]!;
      const cw = clamp(w, 40, maxW);
      const ch = clamp(h, 40, maxH);
      next[idx] = {
        ...it,
        w: cw,
        h: ch,
        x: clamp(it.x, 0, Math.max(0, maxW - cw)),
        y: clamp(it.y, 0, Math.max(0, maxH - ch))
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

    const assetLibRaw =
      ev.dataTransfer?.getData(PdfEditorComponent.assetLibraryDragMime) ||
      ev.dataTransfer?.getData('text/plain') ||
      '';
    const assetPayload = this.parseAssetLibraryDropPayload(assetLibRaw);
    if (assetPayload) {
      const row = this.resolveAssetLibraryRowFromPayload(assetPayload);
      if (row) {
        this.prepareAssetLibraryRowPlacement(row);
      } else {
        this.errorText.set('That asset is no longer in the list. Refresh the Assets Library and try again.');
      }
      return;
    }

    const raw =
      ev.dataTransfer?.getData('application/x-avyro-widget-kind') ||
      ev.dataTransfer?.getData('text/plain') ||
      '';
    const draggableWidgetKinds: WidgetKind[] = ['table', 'text'];
    const kind = draggableWidgetKinds.includes(raw as WidgetKind) ? (raw as WidgetKind) : null;
    if (!kind) {
      const file = ev.dataTransfer?.files?.[0] ?? null;
      if (!file) return;
      if (file.type === 'image/png' || file.type === 'image/jpeg' || file.type.startsWith('video/')) {
        this.errorText.set('Dropping images or videos onto the page is not supported.');
        return;
      }
      this.errorText.set('Drop a supported asset from the library or insert tools.');
      return;
    }

    if (kind === 'text') {
      this.armPlacedTextInsertMode();
      return;
    }
    this.cancelInsertWidgetMode();
    this.insertWidgetPending.set({ kind });
    this.tool.set('text');
    this.focusRightbarInsertPanel();
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
    this.selectedDetectedPdfMedia.set(null);
    this.selectedPlacedTextId.set(null);
    this.focusRightbarInsertPanel();
    this.beginWidgetMove(pageIndex, widgetId, ev);
  }

  protected onWidgetHeaderPointerDown(pageIndex: number, widgetId: string, ev: PointerEvent) {
    ev.stopPropagation();
    ev.preventDefault();
    this.selectedWidgetId.set(widgetId);
    this.selectedDetectedPdfMedia.set(null);
    this.selectedPlacedTextId.set(null);
    this.focusRightbarInsertPanel();
    this.beginWidgetMove(pageIndex, widgetId, ev);
  }

  protected isUnifiedSelectionWidgetKind(kind: WidgetKind): boolean {
    return kind === 'table' || kind === 'text';
  }

  protected onWidgetSelectionToolbarChromePointerDown(ev: PointerEvent) {
    ev.stopPropagation();
  }

  protected onWidgetToolbarGripPointerDown(pageIndex: number, widgetId: string, ev: PointerEvent) {
    if (this.readonlyMode()) return;
    this.onWidgetHeaderPointerDown(pageIndex, widgetId, ev);
  }

  protected cancelWidgetSelection(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    this.selectedWidgetId.set(null);
    this.activeWidgetOp = null;
  }

  protected duplicateWidgetUnified(pageIndex: number, widgetId: string, ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    if (this.readonlyMode()) return;
    const w = this.getWidget(pageIndex, widgetId);
    if (!w || !this.isUnifiedSelectionWidgetKind(w.kind)) return;
    const { overlay } = this.getCanvasPair(pageIndex);
    if (!overlay) return;
    const { w: rw, h: rh } = this.overlayNominalCssSize(overlay);
    const copy = this.deepCloneWidgetForDuplicate(w);
    copy.x = clamp(copy.x, 0, Math.max(0, rw - copy.w));
    copy.y = clamp(copy.y, 0, Math.max(0, rh - copy.h));
    this.widgetsByPage.update((prev) => {
      const cur = prev[pageIndex] ?? [];
      return { ...prev, [pageIndex]: [...cur, copy] };
    });
    this.selectedWidgetId.set(copy.id);
    this.selectedDetectedPdfMedia.set(null);
    this.selectedPlacedTextId.set(null);
  }

  private deepCloneWidgetForDuplicate(w: Widget): Widget {
    const id = this.newWidgetId();
    const step = 14;
    const copy: Widget = {
      ...w,
      id,
      x: w.x + step,
      y: w.y + step
    };
    if (w.table) {
      copy.table = {
        rows: w.table.rows,
        cols: w.table.cols,
        cells: w.table.cells.map((row) => row.slice())
      };
    }
    return copy;
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
    this.selectedDetectedPdfMedia.set(null);
    this.selectedPlacedTextId.set(null);
    this.focusRightbarInsertPanel();

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
    this.widgetsByPage.update((prev) => {
      const cur = prev[pageIndex] ?? [];
      const next = cur.filter((w) => w.id !== widgetId);
      return { ...prev, [pageIndex]: next };
    });
    if (this.selectedWidgetId() === widgetId) this.selectedWidgetId.set(null);
    const target = this.replaceMediaTarget();
    if (target?.widgetId === widgetId) this.replaceMediaTarget.set(null);
    if (this.layeredImagePickTargetWidgetId === widgetId) this.layeredImagePickTargetWidgetId = null;
    if (this.activeWidgetOp?.pageIndex === pageIndex && this.activeWidgetOp.id === widgetId) {
      this.activeWidgetOp = null;
    }
    const crop = this.imageCropSession();
    if (crop?.mode === 'widget' && crop.pageIndex === pageIndex && crop.widgetId === widgetId) {
      this.imageCropSession.set(null);
    }
  }

  protected readonly toolbarItems: ToolbarItem[] = [
    // {
    //   kind: 'button',
    //   id: 'print',
    //   title: 'Print (Clear edits)',
    //   icon: 'print',
    //   onClick: () => this.clearEdits(),
    //   disabled: () => this.pageCount() === 0
    // },
    {
      kind: 'button',
      id: 'extract-template',
      title: 'Extract template',
      icon: 'template',
      onClick: () => void this.extractTemplate(),
      disabled: () => this.pageCount() === 0 || this.isLoading() || this.isSaving()
    },
    // {
    //   kind: 'button',
    //   id: 'spellcheck',
    //   title: 'Spellcheck (noop)',
    //   icon: 'spellcheck',
    //   onClick: () => {}
    // },
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
          onClick: () => this.applyZoomDelta(-PdfEditorComponent.zoomStep)
        },
        {
          kind: 'select',
          id: 'zoom-select',
          title: 'Zoom',
          value: () => this.scale(),
          setValue: (v) => this.scale.set(this.clampZoom(Number(v))),
          options: this.zoomOptions.map((z) => ({ label: `${(z * 100).toFixed(0)}%`, value: z }))
        },
        {
          kind: 'button',
          id: 'zoom-in',
          title: 'Zoom in',
          icon: 'zoomIn',
          onClick: () => this.applyZoomDelta(PdfEditorComponent.zoomStep)
        }
      ]
    },
    { kind: 'sep', id: 'sep-3' },
    {
      kind: 'select',
      id: 'paragraph-style',
      title: 'Paragraph style',
      value: () => 'Normal text',
      setValue: () => { },
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
      setValue: (v) => this.setTextSize(Number(v)),
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
      setValue: (v) => this.setTextBgColor(v),
      disabled: () => !this.textFeatureEnabled() || !this.textBgEnabled()
    },
    {
      kind: 'button',
      id: 'text-color-icon',
      title: 'Text color',
      icon: 'textColor',
      onClick: () => { },
      disabled: () => !this.textFeatureEnabled()
    },
    {
      kind: 'color',
      id: 'text-color',
      title: 'Font color',
      value: () => this.textColor(),
      setValue: (v) => this.setTextColor(v),
      disabled: () => !this.textFeatureEnabled()
    },
    { kind: 'sep', id: 'sep-5' },
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
      if (this.furnitureSaveTimer !== null) {
        clearTimeout(this.furnitureSaveTimer);
        this.furnitureSaveTimer = null;
      }
      if (this.autoVersionSaveTimer !== null) {
        clearTimeout(this.autoVersionSaveTimer);
        this.autoVersionSaveTimer = null;
      }
      if (this.editorRemoteSaveTimer !== null) {
        clearTimeout(this.editorRemoteSaveTimer);
        this.editorRemoteSaveTimer = null;
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
    this.busyHint.set('Loading PDF…');
    this.isLoading.set(true);
    await this.yieldForUiPaint();
    this.fileName.set(file.name);

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      this.assertReadablePdfHeader(bytes);
      this.cancelAllPdfRenderTasks();
      try {
        await this.pdfDoc?.destroy();
      } catch {
        // ignore stale document cleanup failures
      }
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
      this.widgetsByPage.set({});
      this.embeddedImageReplacementByDetectedId.clear();
      this.detectedTextByPage.set({});
      this.detectedBlocksByPage.set({});
      this.detectedMediaByPage.set({});
      this.sectionOverridesByPage.set({});
      this.removedSectionsByPage.set({});
      this.pageFurniture.set(clonePageFurniture(DEFAULT_PAGE_FURNITURE));
      this.syncDynamicFieldDrafts(this.pageFurniture());
      this.resetHistory();
      this.ensureKeySlotSectionOverrides();
      await this.waitForActiveCanvasReady(1200);
      await this.renderActivePage();
      this.generateNearThumbnailsThenRest(5);
      void this.primeSidebarSectionDetection();

      // Rendering will happen via QueryList changes.
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Unsupported format - try PDF or DOCX.');
      this.pdfBytes = null;
      this.pdfDoc = null;
      this.pageCount.set(0);
    } finally {
      this.isLoading.set(false);
      this.busyHint.set('Working…');
      input.value = '';
    }
  }

  protected backToLibrary() {
    void this.router.navigate(['/']);
  }

  private async buildBlankProposalPdfBytes(pageCount: number): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    // Match the default dimensions we already use when inserting pages.
    const size = { width: 595.28, height: 841.89 }; // A4-ish points
    for (let i = 0; i < Math.max(1, pageCount); i++) {
      pdf.addPage([size.width, size.height]);
    }
    const out = await pdf.save();
    const safe = out instanceof Uint8Array ? out : new Uint8Array(out as any);
    return safe;
  }

  /**
   * Flow 1: Start Fresh (create route).
   * Uploads a blank multi-page PDF and loads it into the editor.
   */
  protected async startFreshProposal() {
    if (this.isLoading() || this.isSaving() || this.readonlyMode()) return;

    this.errorText.set(null);
    this.busyHint.set('Creating proposal…');
    this.isLoading.set(true);
    await this.yieldForUiPaint();
    try {
      this.customKeySlots.set([]);

      const bytes = await this.buildBlankProposalPdfBytes(PdfEditorComponent.fixedKeySlots.length);
      const blobBytes = new Uint8Array(bytes.byteLength);
      blobBytes.set(bytes);
      const blob = new Blob([blobBytes.buffer], { type: 'application/pdf' });
      const file = new File([blob], 'Start Fresh Proposal.pdf', { type: 'application/pdf' });

      const meta = await this.api.upload(file);

      this.docId.set(meta.id);
      this.fileName.set(meta.name);

      await this.loadFromApi(meta.id);
      await this.loadProposalVersions(meta.id);
      await this.loadProposalDetails(meta.id);
      await this.loadProposalRejection(meta.id);
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to start fresh proposal.');
    } finally {
      this.isLoading.set(false);
      this.busyHint.set('Working…');
    }
  }

  private async loadFromApi(id: string) {
    this.errorText.set(null);
    this.busyHint.set('Loading document…');
    this.isLoading.set(true);
    await this.yieldForUiPaint();
    try {
      const [meta, serverBytes, furniture, remoteEditorState] = await Promise.all([
        this.api.getMeta(id),
        this.api.getBytes(id),
        this.api.getFurniture(id).catch(() => null),
        this.api.getEditorState(id).catch(() => null)
      ]);

      const nameFromState = remoteEditorState?.fileName?.trim();
      this.fileName.set(nameFromState || meta.name);
      this.assertReadablePdfHeader(serverBytes);

      const sourceBytes = serverBytes;
      const sourceLooksEditable = await this.pdfBytesLookEditableForDetection(serverBytes);
      const hasMeaningfulRemoteState = this.editorStatePayloadIsMeaningful(remoteEditorState);
      this.editorSourceProposalId = sourceLooksEditable ? id : null;
      this.assertReadablePdfHeader(sourceBytes);

      this.cancelAllPdfRenderTasks();
      try {
        await this.pdfDoc?.destroy();
      } catch {
        // ignore stale document cleanup failures
      }
      this.pdfBytes = this.clonePdfBytes(sourceBytes);

      const forPdfJs = this.clonePdfBytes(this.pdfBytes);
      const loadingTask = getDocument({ data: forPdfJs });
      const doc = await loadingTask.promise;
      this.pdfDoc = doc;

      this.pageCount.set(doc.numPages);
      this.activePageIndex.set(0);
      this.openPageMenuIndex.set(null);
      this.sidebarSlideMenuOpenIndex.set(null);
      this.pageThumbUrlByPage.set({});
      const persistedEditorState = await this.parseEditorStateForLoad(remoteEditorState, doc.numPages);
      this.editsByPage.set(persistedEditorState.editsByPage);
      this.embeddedImageReplacementByDetectedId.clear();
      this.detectedTextByPage.set({});
      this.detectedBlocksByPage.set({});
      this.detectedMediaByPage.set({});
      this.sectionOverridesByPage.set({});
      this.removedSectionsByPage.set({});
      // Key slots are session-scoped (re-created on load).
      this.customKeySlots.set([]);
      this.ensureKeySlotSectionOverrides();
      this.widgetsByPage.set(persistedEditorState.widgetsByPage);
      this.pageFurniture.set(
        this.normalizePageFurniture(furniture ?? clonePageFurniture(DEFAULT_PAGE_FURNITURE))
      );
      this.syncDynamicFieldDrafts(this.pageFurniture());
      this.furniturePersistenceReady = true;
      this.resetHistory();
      if (hasMeaningfulRemoteState && !sourceLooksEditable) {
        this.errorText.set('This saved PDF is flattened, so original text/image detection cannot be recovered for this version. Reopen the original upload or clear saved edits to restore detection.');
      }

      // Ensure the first page is fully rendered before we drop the loading banner.
      await this.waitForActiveCanvasReady(1600);
      await this.renderActivePage();
      this.generateNearThumbnailsThenRest(5);
      void this.primeSidebarSectionDetection();
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Upload failed - retry.');
      this.pdfBytes = null;
      this.pdfDoc = null;
      this.pageCount.set(0);
    } finally {
      this.isLoading.set(false);
      this.busyHint.set('Working…');
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
      this.errorText.set(e instanceof Error ? e.message : 'Save failed - reconnecting.');
    }
  }

  protected clearEdits() {
    this.beginHistoryStep('Clear all edits');
    for (const url of this.videoObjectUrlByWidgetId.values()) {
      if (!url.startsWith('blob:')) continue;
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
    this.videoObjectUrlByWidgetId.clear();
    this.embeddedImageReplacementByDetectedId.clear();
    this.editsByPage.set({});
    this.widgetsByPage.set({});
    this.selectedWidgetId.set(null);
    this.editingWidgetId.set(null);
    this.replaceMediaTarget.set(null);
    this.selectedPlacedImageId.set(null);
    this.selectedPlacedTextId.set(null);
    this.imageCropSession.set(null);
    this.activePlacedImageOp = null;
    this.activePlacedTextOp = null;
    // Restore original page renders (replaces are drawn directly onto the base canvas).
    for (let pageIndex = 0; pageIndex < this.pageCount(); pageIndex++) {
      this.restoreBaseFromSnapshot(pageIndex);
    }
    this.redrawAllOverlays();
    this.pushEditHistoryEvent('clear', 'Cleared all edits');
  }

  protected canUndo() {
    return this.undoStack.length > 0;
  }

  protected onMainTitleChange(value: string) {
    if (this.readonlyMode()) return;
    const previousDerivedTitle = this.derivedProposalTitle();
    this.fileName.set(value);
    this.syncProposalTitleWithMainTitle(previousDerivedTitle);
  }

  protected onMainTitleBlur() {
    if (this.readonlyMode()) return;
    const previousDerivedTitle = this.derivedProposalTitle();
    const current = (this.fileName() ?? '').trim();
    if (!current) {
      this.fileName.set('Proposal.pdf');
      this.syncProposalTitleWithMainTitle(previousDerivedTitle);
      return;
    }
    if (current !== this.fileName()) this.fileName.set(current);
    this.syncProposalTitleWithMainTitle(previousDerivedTitle);
  }

  protected canRedo() {
    return this.redoStack.length > 0;
  }

  protected undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    const action = this.undoLabels.pop() ?? 'Canvas edit';
    const cur = this.createHistorySnapshot();
    this.redoStack.push(cur);
    this.redoLabels.push(action);
    this.restoreHistorySnapshot(prev);
    this.pushEditHistoryEvent('undo', `Undo: ${action}`);
    this.afterHistoryRestore();
  }

  protected redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    const action = this.redoLabels.pop() ?? 'Canvas edit';
    const cur = this.createHistorySnapshot();
    this.undoStack.push(cur);
    this.undoLabels.push(action);
    this.restoreHistorySnapshot(next);
    this.pushEditHistoryEvent('redo', `Redo: ${action}`);
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

    if (!ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      if (ev.key === 'ArrowRight' || ev.key === 'PageDown') {
        if (this.pageCount() > 0) {
          ev.preventDefault();
          this.setActivePage(this.activePageIndex() + 1);
        }
        return;
      }
      if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') {
        if (this.pageCount() > 0) {
          ev.preventDefault();
          this.setActivePage(this.activePageIndex() - 1);
        }
        return;
      }
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
    this.undoLabels.length = 0;
    this.redoLabels.length = 0;
    this.editHistoryEvents.set([]);
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

  protected async onSidebarAddPageInSection(pageIndex: number, ev: Event) {
    ev.stopPropagation();
    if (!this.pdfBytes || this.isLoading() || this.isSaving()) return;
    this.sidebarSlideMenuOpenIndex.set(null);
    const source = this.sidebarSectionByPage()[pageIndex];
    await this.addBlankPageAfter(pageIndex);
    if (this.errorText()) return;
    const insertedAt = pageIndex + 1;
    if (source?.title) {
      this.sectionOverridesByPage.update((prev) => ({
        ...prev,
        [insertedAt]: { title: source.title, type: source.type }
      }));
      this.removedSectionsByPage.update((prev) => {
        const next = { ...prev };
        delete next[insertedAt];
        return next;
      });
    }
    this.showSlideToast('Page added in section');
  }

  protected updateSidebarSection(pageIndex: number, ev: Event) {
    ev.stopPropagation();
    if (this.isLoading() || this.isSaving()) return;
    this.sidebarSlideMenuOpenIndex.set(null);
    const current = this.sidebarSectionByPage()[pageIndex];
    const titleInput = (prompt('Section title', current?.title ?? '') ?? '').trim();
    if (!titleInput) return;
    const rawType = (prompt('Section type: section or imageHeader', current?.type ?? 'section') ?? '').trim().toLowerCase();
    const nextType: SidebarSectionType = rawType === 'imageheader' ? 'imageHeader' : 'section';
    this.sectionOverridesByPage.update((prev) => ({
      ...prev,
      [pageIndex]: { title: this.sanitizeSidebarTitle(titleInput), type: nextType }
    }));
    this.removedSectionsByPage.update((prev) => {
      const next = { ...prev };
      delete next[pageIndex];
      return next;
    });
    this.showSlideToast('Section updated');
  }

  protected removeSidebarSection(pageIndex: number, ev: Event) {
    ev.stopPropagation();
    if (this.isLoading() || this.isSaving()) return;
    this.sidebarSlideMenuOpenIndex.set(null);
    this.sectionOverridesByPage.update((prev) => {
      const next = { ...prev };
      delete next[pageIndex];
      return next;
    });
    this.removedSectionsByPage.update((prev) => ({ ...prev, [pageIndex]: true }));
    this.showSlideToast('Section removed');
  }

  protected async onSidebarAddSlideFromTemplate(pageIndex: number, ev: Event) {
    ev.stopPropagation();
    if (!this.pdfBytes || this.isLoading() || this.isSaving()) return;
    this.sidebarSlideMenuOpenIndex.set(null);
    const templateId = (prompt('Template proposal ID') ?? '').trim();
    if (!templateId) return;
    const pageRaw = (prompt('Template page number (1-based)', '1') ?? '').trim();
    const pageNumber = Math.max(1, Number(pageRaw || '1'));
    await this.addSlideFromTemplate(pageIndex, templateId, pageNumber - 1);
    if (!this.errorText()) {
      this.showSlideToast('Slide inserted from template');
    }
  }

  protected scrollToPage(_pageIndex: number) {
    // Single-page mode: nothing to scroll; page switching is handled via `activePageIndex`.
  }

  private beginHistoryStep(label?: string) {
    const action =
      label ??
      (this.tool() === 'pen' ? 'Pen stroke' : this.tool() === 'text' ? 'Text edit' : 'Canvas edit');
    // Save the current state so Undo can restore it.
    const snap = this.createHistorySnapshot();
    this.undoStack.push(snap);
    this.undoLabels.push(action);
    if (this.undoStack.length > this.maxHistoryEntries) {
      this.undoStack.splice(0, this.undoStack.length - this.maxHistoryEntries);
      this.undoLabels.splice(0, this.undoLabels.length - this.maxHistoryEntries);
    }
    this.redoStack.length = 0;
    this.redoLabels.length = 0;
    this.pushEditHistoryEvent('apply', action);
  }

  private pushEditHistoryEvent(kind: EditHistoryEventKind, label: string) {
    const event: EditHistoryEvent = {
      id: `he_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`,
      kind,
      label,
      at: Date.now()
    };
    this.editHistoryEvents.update((prev) => {
      const next = [...prev, event];
      return next.length > this.maxHistoryEntries ? next.slice(next.length - this.maxHistoryEntries) : next;
    });
  }

  /**
   * Deep-clone page edits without `structuredClone` / recursive JSON serializers.
   * Large pixel payloads (placed images, video data URLs on widgets) made those paths
   * fragile (stack / heap) during save and history snapshots.
   */
  private cloneEdits(edits: Record<number, PageEdits>): Record<number, PageEdits> {
    const out: Record<number, PageEdits> = {};
    for (const [k, e] of Object.entries(edits)) {
      const pi = Number(k);
      if (!Number.isFinite(pi) || !e) continue;
      out[pi] = {
        viewportWidth: e.viewportWidth,
        viewportHeight: e.viewportHeight,
        ink: e.ink.map((s) => ({
          color: s.color,
          width: s.width,
          points: s.points.map((p) => ({ x: p.x, y: p.y }))
        })),
        text: e.text.map((t) => ({ ...t })),
        images: e.images.map((im) => ({
          ...im,
          crop: im.crop ? { x: im.crop.x, y: im.crop.y, w: im.crop.w, h: im.crop.h } : undefined
        })),
        replaces: e.replaces.map((r) => ({ ...r }))
      };
    }
    return out;
  }

  private cloneWidgetsByPage(widgetsByPage: Record<number, Widget[]>): Record<number, Widget[]> {
    const out: Record<number, Widget[]> = {};
    for (const [k, list] of Object.entries(widgetsByPage)) {
      const pi = Number(k);
      if (!Number.isFinite(pi) || !list) continue;
      out[pi] = list.map((w) => {
        const next: Widget = { ...w };
        if (w.table) {
          next.table = {
            rows: w.table.rows,
            cols: w.table.cols,
            cells: w.table.cells.map((row) => row.slice())
          };
        }
        return next;
      });
    }
    return out;
  }

  /** FNV-1a–style digest for long strings; avoids megabyte `JSON.stringify` of raw media. */
  private fingerprintHeavyString(s: string | undefined | null, maxInline = 4096): string {
    if (s == null || s === '') return '';
    if (s.length <= maxInline) return s;
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return `~h~${s.length}~${(h >>> 0).toString(16)}`;
  }

  /**
   * Lightweight document fingerprint for auto-version scheduling (not persisted).
   * Full `JSON.stringify` of edits + widgets embedded entire video/image data URLs and could
   * overflow the stack or choke the main thread when saving with video.
   */
  private autoVersionSnapshotFingerprint(
    edits: Record<number, PageEdits>,
    widgets: Record<number, Widget[]>,
    furniture: PageFurniture,
    pageCount: number,
    fileName: string | null
  ): string {
    const fpFurniture = {
      ...furniture,
      logo: {
        ...furniture.logo,
        url: this.fingerprintHeavyString(furniture.logo.url)
      }
    };
    const fpEdits: Record<number, PageEdits> = {};
    for (const [k, e] of Object.entries(edits)) {
      const pi = Number(k);
      if (!Number.isFinite(pi) || !e) continue;
      fpEdits[pi] = {
        viewportWidth: e.viewportWidth,
        viewportHeight: e.viewportHeight,
        ink: e.ink,
        text: e.text.map((t) => ({ ...t, text: this.fingerprintHeavyString(t.text) })),
        images: e.images.map((im) => ({ ...im, dataUrl: this.fingerprintHeavyString(im.dataUrl) })),
        replaces: e.replaces.map((r) => ({
          ...r,
          oldText: this.fingerprintHeavyString(r.oldText),
          newText: this.fingerprintHeavyString(r.newText)
        }))
      };
    }
    const fpWidgets: Record<number, Array<Record<string, unknown>>> = {};
    for (const [k, list] of Object.entries(widgets)) {
      const pi = Number(k);
      if (!Number.isFinite(pi) || !list) continue;
      fpWidgets[pi] = list.map((w) => ({
        id: w.id,
        kind: w.kind,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        textValue: w.textValue !== undefined ? this.fingerprintHeavyString(w.textValue) : undefined,
        table: w.table
          ? {
              rows: w.table.rows,
              cols: w.table.cols,
              cells: w.table.cells.map((row) => row.map((c) => this.fingerprintHeavyString(String(c ?? ''))))
            }
          : undefined
      }));
    }
    return JSON.stringify({ edits: fpEdits, widgets: fpWidgets, furniture: fpFurniture, pageCount, fileName });
  }

  private createHistorySnapshot(): EditorHistorySnapshot {
    return {
      editsByPage: this.cloneEdits(this.editsByPage()),
      widgetsByPage: this.cloneWidgetsByPage(this.widgetsByPage())
    };
  }

  private pdfImageReplacementPageIndex(id: string): number | null {
    const match = /^pdfmedia_replace_p(\d+)_/.exec(id);
    if (!match) return null;
    const pageIndex = Number(match[1]);
    return Number.isInteger(pageIndex) && pageIndex >= 0 ? pageIndex : null;
  }

  /**
   * Replacement overlays are named with their real PDF page. If a delayed callback ever leaves
   * one in the wrong page bucket, export would draw it on that bucket's page. Normalize before
   * saving so the baked PDF and the in-memory overlay agree.
   */
  private normalizePdfImageReplacementPages(edits: Record<number, PageEdits>): Record<number, PageEdits> {
    const out = this.cloneEdits(edits);

    for (const [k, page] of Object.entries(edits)) {
      const sourcePageIndex = Number(k);
      if (!Number.isFinite(sourcePageIndex) || !page?.images?.length) continue;

      for (const img of page.images) {
        const targetPageIndex = this.pdfImageReplacementPageIndex(img.id);
        if (targetPageIndex === null || targetPageIndex === sourcePageIndex) continue;

        const source = out[sourcePageIndex];
        if (!source) continue;
        const target =
          out[targetPageIndex] ??
          ({
            viewportWidth: source.viewportWidth,
            viewportHeight: source.viewportHeight,
            ink: [],
            text: [],
            images: [],
            replaces: []
          } satisfies PageEdits);

        const matchingErase = source.replaces.filter(
          (r) => r.source === 'mediaErase' && this.isSameReplaceRegion(r, img)
        );
        source.images = source.images.filter((im) => im.id !== img.id);
        source.replaces = source.replaces.filter(
          (r) => !(r.source === 'mediaErase' && this.isSameReplaceRegion(r, img))
        );
        target.images = [...target.images.filter((im) => im.id !== img.id), { ...img }];
        target.replaces = [
          ...target.replaces.filter((r) => !matchingErase.some((m) => this.isSameReplaceRegion(r, m))),
          ...matchingErase.map((r) => ({ ...r }))
        ];
        out[targetPageIndex] = target;
      }
    }

    return out;
  }

  private restoreHistorySnapshot(snapshot: EditorHistorySnapshot) {
    this.editsByPage.set(this.patchTextAnnosMissingIds(this.cloneEdits(snapshot.editsByPage)));
    this.widgetsByPage.set(this.cloneWidgetsByPage(snapshot.widgetsByPage));
  }

  /** Older history snapshots omit {@link TextAnno.id}; assign so selection/delete still work after undo. */
  private patchTextAnnosMissingIds(edits: Record<number, PageEdits>): Record<number, PageEdits> {
    const out: Record<number, PageEdits> = { ...edits };
    for (const [k, e] of Object.entries(edits)) {
      const pi = Number(k);
      if (!Number.isFinite(pi) || !e?.text?.length) continue;
      if (!e.text.some((t) => !t.id)) continue;
      out[pi] = {
        ...e,
        text: e.text.map((t, i) =>
          t.id ? t : { ...t, id: `txt_${pi}_${i}_${Math.random().toString(16).slice(2, 10)}` }
        )
      };
    }
    return out;
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
    this.activePlacedImageOp = null;
    this.activePlacedTextOp = null;
    this.activeTextDraftGesture = null;
    this.textDraftFreeRect.set({ w: 320, h: 44 });
    this.selectedPlacedImageId.set(null);
    this.selectedPlacedTextId.set(null);
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
    const hasFlattenOnlyWidgets = Object.values(widgetsByPage).some((list) => (list ?? []).length > 0);
    if (hasFlattenOnlyWidgets) return true;
    return Object.values(editsByPage).some((e) =>
      (e?.replaces ?? []).some((r) => r.maskMode === 'inpaint' || r.source === 'mediaErase')
    );
  }

  /** Map an editor/viewport axis-aligned rect to an axis-aligned box in PDF user space (pdf-lib coordinates). */
  private editorRectToPdfAabb(
    vp: { convertToPdfPoint: (x: number, y: number) => number[] },
    ex: number,
    ey: number,
    ew: number,
    eh: number
  ): { x: number; y: number; width: number; height: number } {
    const pts = [
      vp.convertToPdfPoint(ex, ey),
      vp.convertToPdfPoint(ex + ew, ey),
      vp.convertToPdfPoint(ex, ey + eh),
      vp.convertToPdfPoint(ex + ew, ey + eh)
    ];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * Draw a single line of text positioned from a viewport top-left reference, with alignment along viewport +x.
   */
  private drawSemanticViewportTextLine(
    page: PDFPage,
    vp: { convertToPdfPoint: (x: number, y: number) => number[] },
    raw: string,
    vpAnchorX: number,
    vpAnchorY: number,
    align: 'left' | 'center' | 'right',
    editorFontPx: number,
    fontPdfSize: number,
    font: PDFFont,
    color01: { r: number; g: number; b: number },
    boxWidthVp: number
  ) {
    const t = raw.trim();
    if (!t) return;
    const tw = font.widthOfTextAtSize(t, fontPdfSize);
    const vy = vpAnchorY + editorFontPx * 0.88;
    const [bx, by] = vp.convertToPdfPoint(vpAnchorX, vy);
    const [hx, hy] = vp.convertToPdfPoint(vpAnchorX + 1, vy);
    let ux = hx - bx;
    let uy = hy - by;
    let ulen = Math.hypot(ux, uy);
    if (ulen < 1e-6) {
      ux = 1;
      uy = 0;
      ulen = 1;
    }
    ux /= ulen;
    uy /= ulen;

    if (align === 'right') {
      const [rx, ry] = vp.convertToPdfPoint(vpAnchorX + boxWidthVp, vy);
      const x0 = rx - tw * ux;
      const y0 = ry - tw * uy;
      page.drawText(t, { x: x0, y: y0, size: fontPdfSize, font, color: rgb(color01.r, color01.g, color01.b) });
      return;
    }

    let back = 0;
    if (align === 'center') back = tw / 2;
    const x0 = bx - back * ux;
    const y0 = by - back * uy;
    page.drawText(t, { x: x0, y: y0, size: fontPdfSize, font, color: rgb(color01.r, color01.g, color01.b) });
  }

  /**
   * PDF bytes written to the server on Save / overwrite / auto-version.
   * Must match what Export produces so images, widgets (text/table/video), ink, and replacements persist.
   */
  private async buildSavedProposalPdfBytes(): Promise<Uint8Array> {
    if (!this.pdfBytes) throw new Error('PDF not loaded.');
    return this.exportNeedsFlatten()
      ? await this.buildFlattenedExportBytes()
      : await this.buildSemanticExportBytes();
  }

  /** Semantic PDF with annotations (pen, text, images, etc.). Not used when `exportNeedsFlatten()`. */
  private async buildSemanticExportBytes(editsOverride?: Record<number, PageEdits>): Promise<Uint8Array> {
    if (!this.pdfBytes) throw new Error('PDF not loaded.');
    this.assertReadablePdfHeader(this.pdfBytes);
    const edits = this.normalizePdfImageReplacementPages(editsOverride ?? this.editsByPage());
    const pdf = await PDFDocument.load(this.clonePdfBytes(this.pdfBytes));
    const fontsByFamily: Record<PdfExportFontFamily, Record<FontStyle, PDFFont>> = {
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
      const pageWidgets = this.widgetsByPage()[pageIndex] ?? [];

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

      if (!this.pdfDoc) throw new Error('PDF not loaded.');
      const pdfjsPage = await this.pdfDoc.getPage(pageIndex + 1);
      const vp = pdfjsPage.getViewport({ scale: 1, rotation: this.pdfPageViewportRotation(pdfjsPage) });

      const editW = Math.max(1, edit?.viewportWidth ?? vp.width);
      const editH = Math.max(1, edit?.viewportHeight ?? vp.height);
      const scalePub = Math.min(vp.width / editW, vp.height / editH);

      if (edit) {
        // Replace text first (cover original area, then draw new).
        for (const r of edit.replaces) {
          // NOTE: In semantic PDF export, we can only do a flat rectangle mask.
          // For scanned/image PDFs we should prefer a flatten export instead of 'inpaint' masking.
          const bg = hexToRgb01(r.bgColor);
          const rect = this.editorRectToPdfAabb(vp, r.x, r.y, r.w, r.h);
          page.drawRectangle({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            color: rgb(bg.r, bg.g, bg.b)
          });

          if (r.newText.length > 0) {
            const c = hexToRgb01(r.color);
            const familyRaw: FontFamily = r.fontFamily ?? 'helvetica';
            const family = normalizePdfExportFontFamily(familyRaw);
            const font = fontsByFamily[family]?.[r.fontStyle] ?? fontsByFamily.helvetica.regular;
            const textX = r.textX ?? r.x;
            const textY = r.textY ?? r.y;
            const fontPdf = r.fontSize * scalePub;
            const wrapPdf = (r.textWrapWidth ?? r.w) * (vp.width / editW);
            const lines = this.wrapTextLinesByWidth(r.newText, wrapPdf, (line) =>
              font.widthOfTextAtSize(line, fontPdf)
            );
            const lhVp = Math.max(1, Math.round(r.fontSize * 1.2));
            for (let i = 0; i < lines.length; i++) {
              const [bx, by] = vp.convertToPdfPoint(textX, textY + r.fontSize * 0.88 + i * lhVp);
              page.drawText(lines[i] ?? '', {
                x: bx,
                y: by,
                size: fontPdf,
                font,
                color: rgb(c.r, c.g, c.b)
              });
            }
          }
        }

        await this.drawImagesToPdf(pdf, page, edit, vp);

        for (const stroke of edit.ink) {
          const c = hexToRgb01(stroke.color);
          const tthick = Math.max(0.5, stroke.width * (vp.width / editW));
          for (let i = 1; i < stroke.points.length; i++) {
            const a = stroke.points[i - 1];
            const b = stroke.points[i];
            const sa = vp.convertToPdfPoint(a.x, a.y);
            const sb = vp.convertToPdfPoint(b.x, b.y);
            page.drawLine({
              start: { x: sa[0], y: sa[1] },
              end: { x: sb[0], y: sb[1] },
              thickness: tthick,
              color: rgb(c.r, c.g, c.b)
            });
          }
        }

        for (const t of edit.text) {
          const c = hexToRgb01(t.color);
          const familyRaw: FontFamily = t.fontFamily ?? 'helvetica';
          const family = normalizePdfExportFontFamily(familyRaw);
          const font = fontsByFamily[family]?.[t.fontStyle] ?? fontsByFamily.helvetica.regular;
          const size = t.fontSize * scalePub;
          const lhVp = Math.max(1, Math.round(t.fontSize * 1.2));
          const lines = t.text.split('\n');

          // Optional background fill behind text (best-effort bbox).
          if (t.bgColor) {
            const bg = hexToRgb01(t.bgColor);
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i] ?? '';
              const twPdf = font.widthOfTextAtSize(line, size);
              const twVp = Math.max(1, twPdf / (vp.width / editW));
              const rect = this.editorRectToPdfAabb(vp, t.x, t.y + i * lhVp, twVp, lhVp);
              page.drawRectangle({
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                color: rgb(bg.r, bg.g, bg.b)
              });
            }
          }

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? '';
            if (!line) continue;
            const [bx, by] = vp.convertToPdfPoint(t.x, t.y + t.fontSize * 0.88 + i * lhVp);
            page.drawText(line, {
              x: bx,
              y: by,
              size,
              font,
              color: rgb(c.r, c.g, c.b)
            });
          }
        }
      }

      await this.drawSemanticWidgetsToPdf(pdf, page, pageWidgets, vp);
      await this.drawSemanticPageFurnitureToPdf(pdf, page, vp, pageIndex, edit, fontsByFamily.helvetica.regular);
    }

    const out = await pdf.save();
    const safeBytes = new Uint8Array(out.byteLength);
    safeBytes.set(out);
    return safeBytes;
  }

  private async drawSemanticWidgetsToPdf(
    _pdf: PDFDocument,
    _page: PDFPage,
    _widgets: Widget[],
    _vp: { width: number; height: number; convertToPdfPoint: (x: number, y: number) => number[] }
  ) {
    // Table/text widgets are included via the flattened export path.
  }

  /**
   * Rasterize each page and rebuild a PDF (required when inpaint masking is used).
   */
  private async buildFlattenedExportBytes(
    editsOverride?: Record<number, PageEdits>,
    widgetsOverride?: Record<number, Widget[]>
  ): Promise<Uint8Array> {
    if (!this.pdfBytes || !this.pdfDoc) throw new Error('PDF not loaded.');

    this.assertReadablePdfHeader(this.pdfBytes);
    const outPdf = await PDFDocument.create();

    const edits = this.normalizePdfImageReplacementPages(editsOverride ?? this.editsByPage());
    const widgetsByPage = widgetsOverride ?? this.widgetsByPage();

    // Render at higher scale for better quality.
    const renderScale = Math.max(2, this.scale());
    const pageCount = this.pdfDoc.numPages;

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const edit = edits[pageIndex];

      // Render original page via pdf.js.
      const page = await this.pdfDoc.getPage(pageIndex + 1);
      const originalRotate = ((page.rotate ?? 0) % 360 + 360) % 360;
      const rotation = originalRotate === 180 ? 0 : originalRotate;
      const viewport = page.getViewport({ scale: renderScale, rotation });
      const sizeVp = page.getViewport({ scale: 1, rotation });
      const width = sizeVp.width;
      const height = sizeVp.height;

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable.');

      await page.render({ canvasContext: ctx, viewport, canvas }).promise;

      // Composite edits + widgets in viewport coordinates.
      const fx = viewport.width / (edit?.viewportWidth ?? viewport.width);
      const fy = viewport.height / (edit?.viewportHeight ?? viewport.height);

      if (edit) {
        // Replaces (color or inpaint)
        for (const r of edit.replaces) {
          const rx = r.x * fx;
          const ry = r.y * fy;
          const rw = r.w * fx;
          const rh = r.h * fy;

          if (r.maskMode === 'inpaint' && r.source !== 'textEdit') {
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
            const wrapWidth = (r.textWrapWidth ?? r.w) * fx;
            const lines = this.wrapTextLinesByWidth(r.newText, wrapWidth, (line) => ctx.measureText(line).width);
            const lh = Math.max(1, Math.round(r.fontSize * fy * 1.2));
            const textX = (r.textX ?? r.x) * fx;
            const textY = (r.textY ?? r.y) * fy;
            for (let i = 0; i < lines.length; i++) {
              ctx.fillText(lines[i], textX, textY + i * lh);
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
        for (const img of edit.images ?? []) {
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
      }

      // Widgets should be flattened even when no text/ink edits exist on this page.
      await this.drawWidgetsToFlattenCanvas(pageIndex, ctx, fx, fy, widgetsByPage);
      this.drawPageFurnitureToFlattenCanvas(pageIndex, ctx, fx, fy);

      // Embed raster at PDF.js viewport size so each output page matches editor pagination (incl. 90°/270°).
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
    }
  }

  private drawPageFurnitureToFlattenCanvas(pageIndex: number, ctx: CanvasRenderingContext2D, fx: number, fy: number) {
    const furniture = this.pageFurniture();
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const padX = 20 * fx;
    const headerY = 16 * fy;
    const footerY = ch - 24 * fy;

    const drawAlignedText = (txt: string, align: CanvasTextAlign, x: number, y: number) => {
      if (!txt.trim()) return;
      ctx.save();
      ctx.fillStyle = 'rgba(15,23,42,0.88)';
      ctx.font = `${Math.max(11, 12 * Math.min(fx, fy))}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI"`;
      ctx.textAlign = align;
      ctx.textBaseline = 'top';
      ctx.fillText(txt, x, y);
      ctx.restore();
    };

    if (furniture.header.visible) {
      const text = this.furnitureText(furniture.header.content, pageIndex);
      if (furniture.header.alignment === 'left') drawAlignedText(text, 'left', padX, headerY);
      if (furniture.header.alignment === 'center') drawAlignedText(text, 'center', cw / 2, headerY);
      if (furniture.header.alignment === 'right') drawAlignedText(text, 'right', cw - padX, headerY);
    }

    if (furniture.footer.visible) {
      if (furniture.footer.divider) {
        ctx.save();
        ctx.strokeStyle = 'rgba(15,23,42,0.2)';
        ctx.lineWidth = Math.max(1, Math.min(fx, fy));
        ctx.beginPath();
        ctx.moveTo(padX, ch - 40 * fy);
        ctx.lineTo(cw - padX, ch - 40 * fy);
        ctx.stroke();
        ctx.restore();
      }
      drawAlignedText(this.furnitureText(furniture.footer.leftContent, pageIndex), 'left', padX, footerY);
      drawAlignedText(this.furnitureText(furniture.footer.centerContent, pageIndex), 'center', cw / 2, footerY);
      drawAlignedText(this.furnitureText(furniture.footer.rightContent, pageIndex), 'right', cw - padX, footerY);
    }

    const pageLabel = this.pageNumberLabel(pageIndex);
    if (pageLabel) {
      const pos = furniture.pageNumber.position;
      if (pos === 'header-left') drawAlignedText(pageLabel, 'left', padX, headerY);
      else if (pos === 'header-right') drawAlignedText(pageLabel, 'right', cw - padX, headerY);
      else if (pos === 'footer-left') drawAlignedText(pageLabel, 'left', padX, footerY);
      else if (pos === 'footer-center') drawAlignedText(pageLabel, 'center', cw / 2, footerY);
      else drawAlignedText(pageLabel, 'right', cw - padX, footerY);
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

      // Download is an export action. Keep the editable editor document state separate
      // so a refresh does not turn layers into baked, non-editable PDF pixels.
      const id = this.docId();
      if (id) void this.persistEditorStateToRemote(id, this.editsByPage(), this.widgetsByPage(), this.fileName());

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
      this.errorText.set(e instanceof Error ? e.message : 'Export failed - network issue.');
    } finally {
      this.isLoading.set(false);
    }
  }

  protected async previewProposal() {
    if (!this.pdfBytes) return;
    this.errorText.set(null);
    this.isLoading.set(true);
    try {
      const safeBytes = this.exportNeedsFlatten()
        ? await this.buildFlattenedExportBytes()
        : await this.buildSemanticExportBytes();
      const blobBytes = new Uint8Array(safeBytes.byteLength);
      blobBytes.set(safeBytes);
      const blob = new Blob([blobBytes.buffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 20000);
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Preview failed. Please retry export.');
    } finally {
      this.isLoading.set(false);
    }
  }

  protected async downloadAsPpt() {
    this.showSlideToast('PPT export is queued for backend conversion');
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
        return { ...w };
      });
      out[pageIndex] = widgets;
    }
    return out;
  }

  protected readonly isSaving = signal(false);

  protected openOverwriteConfirmation() {
    if (this.readonlyMode()) return;
    this.overwriteConfirmOpen.set(true);
  }

  protected closeOverwriteConfirmation() {
    this.overwriteConfirmOpen.set(false);
  }

  protected openRejectConfirmation(level: RejectionLevel) {
    if (this.readonlyMode()) return;
    this.rejectConfirmLevel.set(level);
    this.rejectConfirmOpen.set(true);
  }

  protected closeRejectConfirmation() {
    this.rejectConfirmOpen.set(false);
  }

  protected async confirmRejectProposal() {
    const level = this.rejectConfirmLevel();
    this.closeRejectConfirmation();
    await this.rejectProposal(level);
  }

  protected async confirmOverwriteProposal() {
    const id = this.docId();
    if (!id || !this.pdfBytes || this.pageCount() === 0) return;
    this.errorText.set(null);
    this.isSaving.set(true);
    try {
      const safeBytes = await this.buildSavedProposalPdfBytes();
      await this.api.overwriteProposal(id, safeBytes, this.getEditedBy());
      this.cancelEditorStatePersist();
      await this.persistEditorStateToRemote(id, this.editsByPage(), this.widgetsByPage(), this.fileName());
      try {
        await this.api.putFurniture(id, this.normalizePageFurniture(this.pageFurniture()));
      } catch {
        // Bytes updated; furniture sync is best-effort.
      }
      this.showSlideToast('Original overwritten successfully');
      await this.loadFromApi(id);
      await this.loadProposalVersions(id);
      this.closeOverwriteConfirmation();
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to overwrite proposal.');
    } finally {
      this.isSaving.set(false);
    }
  }

  /** Persists edits, source PDF, and furniture (same snapshot as auto-save), with explicit feedback. */
  protected async saveChanges() {
    if (this.readonlyMode()) return;
    const id = this.docId();
    if (!id || !this.pdfBytes || this.pageCount() === 0) return;
    if (this.isLoading() || this.isSaving()) return;

    if (this.autoVersionSaveTimer !== null) {
      clearTimeout(this.autoVersionSaveTimer);
      this.autoVersionSaveTimer = null;
    }

    const waitStart = Date.now();
    while (this.autoVersionSaveInFlight && Date.now() - waitStart < 10_000) {
      await new Promise((r) => setTimeout(r, 40));
    }
    if (this.autoVersionSaveInFlight) return;

    if (this.hasUnsavedDynamicFields()) {
      this.pageFurniture.update((prev) => ({
        ...prev,
        proposalTitle: this.proposalTitleDraft(),
        clientName: this.clientNameDraft()
      }));
    }

    this.errorText.set(null);
    this.isSaving.set(true);
    this.autoVersionSavePending = false;
    try {
      this.cancelEditorStatePersist();
      await this.persistEditorStateToRemote(id, this.editsByPage(), this.widgetsByPage(), this.fileName());
      try {
        await this.api.putFurniture(id, this.normalizePageFurniture(this.pageFurniture()));
      } catch {
        // Editor state is on the server; furniture can retry.
      }
      this.showSlideToast('Saved');
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Save failed');
    } finally {
      this.isSaving.set(false);
    }
  }

  protected async viewProposalVersion(version: ProposalVersion) {
    await this.router.navigate(['/edit', version.proposalId]);
  }

  protected openClearAllEditsConfirmation() {
    if (this.readonlyMode() || this.pageCount() === 0 || !this.docId()) return;
    this.clearAllEditsConfirmOpen.set(true);
  }

  protected closeClearAllEditsConfirmation() {
    this.clearAllEditsConfirmOpen.set(false);
  }

  /**
   * Removes saved derivative PDFs for this document, clears local overlay/title/furniture
   * persistence, and reloads the root upload. Does not revert server PDF bytes if the root
   * file was overwritten by export/save—only removes version copies and in-browser edits.
   */
  protected async confirmClearAllEdits() {
    const id = this.docId();
    if (!id || this.readonlyMode() || this.clearingAllEdits()) return;
    this.clearingAllEdits.set(true);
    this.errorText.set(null);
    try {
      const { rootId, deletedIds } = await this.api.clearProposalVersions(id);
      const idsToClear = new Set<string>([rootId, ...deletedIds, id]);
      this.clearLocalDocPersistence([...idsToClear]);
      this.closeClearAllEditsConfirmation();
      await this.router.navigate(['/edit', rootId], { replaceUrl: true });
      this.docId.set(rootId);
      await this.loadFromApi(rootId);
      await this.loadProposalVersions(rootId);
      await this.loadProposalDetails(rootId);
      await this.loadProposalRejection(rootId);
      this.showSlideToast('Edits cleared; reopened original document');
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to clear edits.');
    } finally {
      this.clearingAllEdits.set(false);
    }
  }

  private clearLocalDocPersistence(ids: string[]) {
    for (const docId of ids) {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(this.editorStateStorageKey(docId));
        localStorage.removeItem(this.titleStorageKey(docId));
        localStorage.removeItem(this.pageFurnitureStorageKey(docId));
        localStorage.removeItem(this.legacyMediaWidgetsStorageKey(docId));
      }
    }
  }

  private async loadProposalVersions(id: string) {
    this.isVersionHistoryLoading.set(true);
    try {
      const versions = await this.api.getProposalVersions(id);
      this.versionHistory.set(versions);
    } catch {
      this.versionHistory.set([]);
    } finally {
      this.isVersionHistoryLoading.set(false);
    }
  }

  private async loadProposalDetails(id: string) {
    try {
      const details = await this.api.getProposal(id);
      this.proposalDetails.set(details);
      this.rejection.set(details.rejection ?? null);
    } catch {
      this.proposalDetails.set(null);
    }
  }

  private async loadProposalRejection(id: string) {
    try {
      const rej = await this.api.getProposalRejection(id);
      this.rejection.set(rej);
    } catch {
      this.rejection.set(null);
    }
  }

  private buildVersionName(currentName: string): string {
    const dot = currentName.lastIndexOf('.');
    const hasExt = dot > 0;
    const base = hasExt ? currentName.slice(0, dot) : currentName;
    const ext = hasExt ? currentName.slice(dot) : '.pdf';
    const match = base.match(/(.+)\s\(v(\d+)\)$/i);
    if (!match) return `${base} (v2)${ext}`;
    const stem = match[1];
    const num = Number(match[2] ?? 1);
    const next = Number.isFinite(num) ? num + 1 : 2;
    return `${stem} (v${next})${ext}`;
  }

  private scheduleAutoVersionSave() {
    if (this.autoVersionSaveTimer !== null) {
      clearTimeout(this.autoVersionSaveTimer);
      this.autoVersionSaveTimer = null;
    }
    this.autoVersionSaveTimer = setTimeout(() => {
      this.autoVersionSaveTimer = null;
      void this.flushAutoVersionSave();
    }, 400);
  }

  private async flushAutoVersionSave() {
    const id = this.docId();
    if (!id || !this.pdfBytes || this.pageCount() === 0) return;
    if (this.readonlyMode()) return;
    if (this.isLoading() || this.isSaving()) {
      this.autoVersionSavePending = true;
      return;
    }
    if (this.autoVersionSaveInFlight) {
      this.autoVersionSavePending = true;
      return;
    }
    this.autoVersionSaveInFlight = true;
    this.isAutoVersionSaving.set(true);
    try {
      this.cancelEditorStatePersist();
      await this.persistEditorStateToRemote(id, this.editsByPage(), this.widgetsByPage(), this.fileName());
      try {
        await this.api.putFurniture(id, this.normalizePageFurniture(this.pageFurniture()));
      } catch {
        // Editor state is on the server; furniture can retry.
      }
    } catch {
      // Avoid blocking editing flow for auto-version failures.
    } finally {
      this.autoVersionSaveInFlight = false;
      this.isAutoVersionSaving.set(false);
      if (this.autoVersionSavePending) {
        this.autoVersionSavePending = false;
        this.scheduleAutoVersionSave();
      }
    }
  }

  private getCanvasPair(pageIndex: number) {
    // Single-page mode: there is only one canvas pair, mapped to the active page index.
    if (pageIndex !== this.activePageIndex()) return { base: null, overlay: null };
    const base = this.pageCanvases?.get(0)?.nativeElement ?? null;
    const overlay = this.overlayCanvases?.get(0)?.nativeElement ?? null;
    return { base, overlay };
  }

  /**
   * Same rotation policy as {@link renderPage} / export: neutralize incorrect 180° PDF metadata only.
   * All text detection, hit-testing, and rasterization must use this so boxes align with the canvas.
   */
  private pdfPageViewportRotation(page: { rotate?: number }): number {
    const originalRotate = ((page.rotate ?? 0) % 360 + 360) % 360;
    return originalRotate === 180 ? 0 : originalRotate;
  }

  /** PDF.js viewport in CSS pixels at the current editor zoom — single source of truth with the page canvases. */
  private getCssViewportForPdfPage(page: {
    rotate?: number;
    getViewport: (opts: { scale: number; rotation: number }) => any;
  }) {
    return page.getViewport({ scale: this.scale(), rotation: this.pdfPageViewportRotation(page) });
  }

  /** Canvas backing-store size matches viewport CSS size × devicePixelRatio; this returns the CSS coordinate extents. */
  private overlayNominalCssSize(overlay: HTMLCanvasElement): { w: number; h: number } {
    const dpr = window.devicePixelRatio || 1;
    return { w: overlay.width / dpr, h: overlay.height / dpr };
  }

  /** Keeps export/replace math aligned with the canvas when edits lack viewport metadata (e.g. 1×1 placeholder). */
  private mergePageEditViewport(pageIndex: number, existing: PageEdits): { viewportWidth: number; viewportHeight: number } {
    const ew = existing.viewportWidth;
    const eh = existing.viewportHeight;
    if (ew > 1 && eh > 1) return { viewportWidth: ew, viewportHeight: eh };
    if (pageIndex === this.activePageIndex()) {
      const { overlay } = this.getCanvasPair(pageIndex);
      if (overlay) {
        const { w, h } = this.overlayNominalCssSize(overlay);
        if (w > 1 && h > 1) return { viewportWidth: w, viewportHeight: h };
      }
    }
    return { viewportWidth: Math.max(1, ew), viewportHeight: Math.max(1, eh) };
  }

  private async renderActivePage() {
    if (!this.pdfDoc) return;

    const epoch = ++this.renderAllPagesEpoch;
    const pageIndex = clamp(this.activePageIndex(), 0, Math.max(0, this.pageCount() - 1));
    if (epoch !== this.renderAllPagesEpoch) return;
    this.isPageRendering.set(true);
    try {
      await this.renderPage(pageIndex, epoch);
      this.redrawOverlay(pageIndex);
    } catch (e) {
      // pdf.js throws cancellation exceptions when a render is superseded by a newer one.
      // Those are expected during fast interactions (zoom/page changes) and should stay silent.
      if (!this.isPdfRenderCancellationError(e)) throw e;
    } finally {
      if (epoch === this.renderAllPagesEpoch) this.isPageRendering.set(false);
    }
  }

  private isPdfRenderCancellationError(err: unknown): boolean {
    if (!err) return false;
    const maybe = err as { name?: unknown; message?: unknown };
    const name = String(maybe.name ?? '').toLowerCase();
    const message = String(maybe.message ?? '').toLowerCase();
    return (
      name.includes('renderingcancelledexception') ||
      name.includes('renderingcancelexception') ||
      message.includes('rendering cancelled') ||
      message.includes('rendering canceled')
    );
  }

  private async renderPage(pageIndex: number, renderEpoch: number) {
    if (!this.pdfDoc) return;

    const { base, overlay } = this.getCanvasPair(pageIndex);
    if (!base || !overlay) return;

    const page = await this.pdfDoc.getPage(pageIndex + 1);
    const dpr = window.devicePixelRatio || 1;

    // pdf.js-recommended HiDPI rendering:
    // - Keep `viewport` in CSS pixels (includes page rotation correctly)
    // - Scale the backing store via canvas width/height
    // - Let pdf.js handle DPR scaling through the `transform` option (equivalent to ctx.setTransform(dpr,…))
    const originalRotate = ((page.rotate ?? 0) % 360 + 360) % 360;
    this.pageRotateByPage.set(pageIndex, originalRotate);
    const cssViewport = this.getCssViewportForPdfPage(page);

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

    if (renderEpoch !== this.renderAllPagesEpoch) return;

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
            fontStyle,
            fontFamily: inferFontFamilyFromPdfJsStyle(styles[fontName] ?? { fontName })
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

    // Media detection is independent from text editing, so keep it enabled.
    try {
      await this.detectPdfMediaForPage(pageIndex, page, cssViewport);
    } catch {
      this.detectedMediaByPage.update((prev) => ({ ...prev, [pageIndex]: [] }));
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
    if (target.closest('.page__overlay')) return;
    if (target.closest('.sidebarSlideMenu')) return;
    if (target.closest('.pageMenu')) return;
    if (target.closest('.pageMenuBtn')) return;
    if (target.closest('.widget')) return;
    if (target.closest('.placedImageHudToolbar')) return;
    if (target.closest('.imageCropBar')) return;
    if (target.closest('.insertSourceMenu')) return;
    if (target.closest('.rightbarMediaActions')) return;
    if (target.closest('.detectedMediaFloatingToolbarAnchor')) return;
    if (target.closest('.placedImageFloatingToolbarAnchor')) return;
    if (target.closest('.textDraft')) return;
    if (this.selectedWidgetId() !== null) this.selectedWidgetId.set(null);
    if (this.selectedDetectedPdfMedia() !== null) this.selectedDetectedPdfMedia.set(null);
    if (this.openPageMenuIndex() !== null) this.openPageMenuIndex.set(null);
    if (this.sidebarSlideMenuOpenIndex() !== null) this.sidebarSlideMenuOpenIndex.set(null);
    if (this.selectedPlacedImageId() !== null) this.selectedPlacedImageId.set(null);
    if (this.selectedPlacedTextId() !== null) this.selectedPlacedTextId.set(null);
    if (this.imageCropSession() !== null) this.imageCropSession.set(null);
    if (this.insertSourceMenu() !== null) this.insertSourceMenu.set(null);
  }

  protected selectedItemWidget(): { pageIndex: number; widget: Widget } | null {
    const id = this.selectedWidgetId();
    if (!id) return null;
    const pageIndex = this.activePageIndex();
    const widget = this.getWidget(pageIndex, id);
    if (!widget) return null;
    return { pageIndex, widget };
  }

  protected selectedDetectedMediaItem(): { pageIndex: number; media: DetectedPdfMedia } | null {
    return this.selectedDetectedPdfMedia();
  }

  protected selectedDetectedMediaTitle(): string {
    const selected = this.selectedDetectedPdfMedia();
    if (!selected) return '';
    return selected.media.kind === 'video' ? 'Detected video' : 'Detected image';
  }

  protected selectedPlacedImage(): { pageIndex: number; image: ImageAnno } | null {
    const id = this.selectedPlacedImageId();
    if (!id) return null;
    const activePageIndex = this.activePageIndex();
    const activeImage = this.getImageAnno(activePageIndex, id);
    if (activeImage) return { pageIndex: activePageIndex, image: activeImage };

    for (const [k, e] of Object.entries(this.editsByPage())) {
      const pageIndex = Number(k);
      if (!Number.isFinite(pageIndex) || pageIndex === activePageIndex) continue;
      const image = e?.images?.find((im) => im.id === id);
      if (image) return { pageIndex, image };
    }
    return null;
  }

  protected placedImageToolbarPositionStyle(sel: { pageIndex: number; image: ImageAnno }): Record<string, string> {
    const im = sel.image;
    return {
      position: 'absolute',
      left: `${im.x + im.w / 2}px`,
      top: `${im.y}px`,
      transform: `translate(-50%, calc(-100% - 6px))`,
      zIndex: '20'
    };
  }

  protected detectedMediaFloatingToolbarStyle(dm: { pageIndex: number; media: DetectedPdfMedia }): Record<string, string> {
    const m = dm.media;
    return {
      position: 'absolute',
      left: `${m.x + m.w / 2}px`,
      top: `${m.y}px`,
      transform: 'translate(-50%, calc(-100% - 6px))',
      zIndex: '20'
    };
  }

  protected onPlacedImageToolbarChromePointerDown(ev: PointerEvent) {
    ev.stopPropagation();
  }

  protected onDetectedMediaFloatingToolbarChromePointerDown(ev: PointerEvent) {
    ev.stopPropagation();
  }

  protected cancelPlacedImageSelection(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    const pageBefore = this.selectedPlacedImage()?.pageIndex ?? this.activePageIndex();
    this.selectedPlacedImageId.set(null);
    this.activePlacedImageOp = null;
    this.imageCropSession.set(null);
    this.redrawOverlay(pageBefore);
  }

  protected cancelDetectedMediaSelectionOnly(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    const sel = this.selectedDetectedPdfMedia();
    if (!sel) return;
    const page = sel.pageIndex;
    this.selectedDetectedPdfMedia.set(null);
    this.redrawOverlay(page);
  }

  protected duplicateSelectedPlacedImage(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    const sel = this.selectedPlacedImage();
    if (!sel) return;
    this.duplicatePlacedImageAt(sel.pageIndex, sel.image);
  }

  protected duplicateDetectedMediaReplacement(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    const det = this.selectedDetectedPdfMedia();
    if (!det || det.media.kind !== 'image') return;
    const anno = this.findReplacementImageAnnoForDetected(det.pageIndex, det.media);
    if (!anno) {
      this.errorText.set('Replace the image first, then you can duplicate it.');
      return;
    }
    this.errorText.set(null);
    this.duplicatePlacedImageAt(det.pageIndex, anno);
    this.selectedDetectedPdfMedia.set(null);
  }

  private duplicatePlacedImageAt(pageIndex: number, image: ImageAnno) {
    const copy: ImageAnno = {
      ...image,
      id: this.newPlacedImageId(),
      x: image.x + 16,
      y: image.y + 16
    };
    this.pushImageAnno(pageIndex, copy);
    this.selectedPlacedImageId.set(copy.id);
    this.redrawOverlay(pageIndex);
  }

  protected onPlacedImageToolbarGripPointerDown(ev: PointerEvent) {
    if (this.readonlyMode()) return;
    const sel = this.selectedPlacedImage();
    if (!sel) return;
    const { pageIndex, image } = sel;
    const { overlay } = this.getCanvasPair(pageIndex);
    if (!overlay) return;
    const pt = this.eventToPoint(overlay, ev);
    (ev.currentTarget as HTMLElement | null)?.setPointerCapture?.(ev.pointerId);
    this.activePlacedImageOp = {
      pageIndex,
      id: image.id,
      pointerId: ev.pointerId,
      mode: 'move',
      edge: null,
      startX: pt.x,
      startY: pt.y,
      orig: { x: image.x, y: image.y, w: image.w, h: image.h },
      historyBegun: false
    };
    ev.preventDefault();
    ev.stopPropagation();
  }

  protected replaceSelectedPlacedImage(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    const sel = this.selectedPlacedImage();
    if (!sel) return;
    this.placedImageReplaceTarget = { pageIndex: sel.pageIndex, id: sel.image.id };
    const el = this.widgetImageFile?.nativeElement;
    if (el) {
      el.value = '';
      el.click();
    }
  }

  protected async onWidgetImagePicked(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      this.errorText.set('Please select a PNG or JPEG image.');
      return;
    }
    this.errorText.set(null);
    this.isInserting.set(true);
    try {
      const dataUrl = await this.readAndCropImageFile(file);
      if (!dataUrl) return;

      const placedTarget = this.placedImageReplaceTarget;
      if (placedTarget) {
        this.placedImageReplaceTarget = null;
        await this.replacePlacedImageFromDataUrl(placedTarget.pageIndex, placedTarget.id, dataUrl);
        return;
      }

      const embeddedTarget = this.embeddedMediaReplaceTarget;
      if (embeddedTarget && embeddedTarget.kind === 'image') {
        this.embeddedMediaReplaceTarget = null;
        await this.placeReplacementImageInPdfMediaRect(embeddedTarget.pageIndex, dataUrl, {
          id: embeddedTarget.id,
          kind: 'image',
          x: embeddedTarget.x,
          y: embeddedTarget.y,
          w: embeddedTarget.w,
          h: embeddedTarget.h
        });
        return;
      }

      this.errorText.set('Select an image in the page first, then use Replace.');
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to replace image.');
    } finally {
      this.isInserting.set(false);
    }
  }

  private async replacePlacedImageFromDataUrl(pageIndex: number, id: string, dataUrl: string) {
    const src = await this.loadHtmlImage(dataUrl);
    this.beginHistoryStep();
    this.updatePlacedImage(pageIndex, id, (a) => ({
      ...a,
      dataUrl,
      srcW: Math.max(1, src.naturalWidth),
      srcH: Math.max(1, src.naturalHeight),
      crop: undefined
    }));
    this.selectedPlacedImageId.set(id);
    this.redrawOverlay(pageIndex);
  }

  protected replaceSelectedDetectedMedia(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    const selected = this.selectedDetectedPdfMedia();
    if (!selected) return;
    this.beginEmbeddedMediaReplace(selected.pageIndex, selected.media);
  }

  protected cropSelectedDetectedEmbeddedImage(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    const selected = this.selectedDetectedPdfMedia();
    if (!selected || selected.media.kind !== 'image') return;
    const { pageIndex, media } = selected;
    const anno = this.findReplacementImageAnnoForDetected(pageIndex, media);
    if (!anno) {
      this.errorText.set(
        'Crop works on your replacement picture. Click Replace, pick an image, then Crop to fine-tune it.'
      );
      return;
    }
    this.errorText.set(null);
    this.selectedPlacedImageId.set(anno.id);
    this.openPlacedImageCropSession(pageIndex, anno.id);
  }

  private detectedMediaLinkKey(pageIndex: number, detectedId: string): string {
    return `${pageIndex}:${detectedId}`;
  }

  /**
   * Find the user-placed overlay for an embedded PDF image. Geometry-based ids can miss after
   * media re-detection (sub-pixel drift); we also store a direct link and fall back to bbox match.
   */
  private findReplacementImageAnnoForDetected(pageIndex: number, media: DetectedPdfMedia): ImageAnno | null {
    const images = this.editsByPage()[pageIndex]?.images ?? [];
    if (images.length === 0) return null;

    const exactId = this.replacementImageIdForBox(pageIndex, media);
    const byExact = images.find((i) => i.id === exactId);
    if (byExact) return byExact;

    const mappedId = this.embeddedImageReplacementByDetectedId.get(this.detectedMediaLinkKey(pageIndex, media.id));
    if (mappedId) {
      const byMap = images.find((i) => i.id === mappedId);
      if (byMap) return byMap;
    }

    const prefix = `pdfmedia_replace_p${pageIndex}_`;
    const cxA = media.x + media.w / 2;
    const cyA = media.y + media.h / 2;
    const maxDim = Math.max(40, media.w, media.h);

    let best: ImageAnno | null = null;
    let bestDist = Infinity;
    for (const im of images) {
      if (!im.id.startsWith(prefix)) continue;
      const cxB = im.x + im.w / 2;
      const cyB = im.y + im.h / 2;
      const d = Math.hypot(cxA - cxB, cyA - cyB);
      if (d < bestDist) {
        bestDist = d;
        best = im;
      }
    }
    if (best && bestDist <= maxDim * 0.55) return best;
    return null;
  }

  protected onDetectedEmbeddedImageDragOver(ev: DragEvent) {
    if (!ev.dataTransfer?.types?.includes('Files')) return;
    ev.preventDefault();
    ev.stopPropagation();
    try {
      ev.dataTransfer!.dropEffect = 'copy';
    } catch {
      // ignore
    }
  }

  protected async onDetectedEmbeddedImageDrop(ev: DragEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    if (this.readonlyMode()) {
      this.errorText.set('This document is read-only.');
      return;
    }
    const selected = this.selectedDetectedPdfMedia();
    if (!selected || selected.media.kind !== 'image') {
      this.errorText.set('Click the embedded image on the page first, then drop a replacement here.');
      return;
    }
    const file = ev.dataTransfer?.files?.[0] ?? null;
    if (!file) return;
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      this.errorText.set('Drop a PNG or JPEG image.');
      return;
    }
    this.errorText.set(null);
    this.isInserting.set(true);
    try {
      const dataUrl = await this.readAndCropImageFile(file);
      if (!dataUrl) return;
      await this.placeReplacementImageInPdfMediaRect(selected.pageIndex, dataUrl, selected.media);
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to replace image.');
    } finally {
      this.isInserting.set(false);
    }
  }

  protected removeSelectedDetectedMedia(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    const selected = this.selectedDetectedPdfMedia();
    if (!selected) return;
    this.eraseDetectedPdfMedia(selected.pageIndex, selected.media);
    this.selectedDetectedPdfMedia.set(null);
  }

  protected selectedWidgetTitle(): string {
    const selected = this.selectedItemWidget();
    if (!selected) return '';
    switch (selected.widget.kind) {
      case 'text':
        return 'Selected text';
      case 'table':
        return 'Selected table';
      default:
        return 'Selected item';
    }
  }

  protected canReplaceSelectedWidget(): boolean {
    const selected = this.selectedItemWidget();
    if (!selected) return false;
    return selected.widget.kind === 'text' && this.textFeatureEnabled();
  }

  protected replaceSelectedWidget(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    const selected = this.selectedItemWidget();
    if (!selected) return;
    const { widget } = selected;
    if (widget.kind === 'text' && this.textFeatureEnabled()) this.startEditingWidget(widget.id);
  }

  protected removeSelectedWidget(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    const selected = this.selectedItemWidget();
    if (!selected) return;
    this.removeWidget(selected.pageIndex, selected.widget.id);
  }

  private rememberReusableAsset(next: ReusableAsset) {
    this.reusableAssets.update((prev) => {
      const duplicateIdx = prev.findIndex((a) => {
        if (next.source === 'crm' && a.source === 'crm' && next.crmAssetId && a.crmAssetId) {
          return a.crmAssetId === next.crmAssetId;
        }
        if (a.kind !== next.kind || a.source !== next.source) return false;
        return a.imageSrc === next.imageSrc;
      });
      if (duplicateIdx === -1) return [next, ...prev].slice(0, PdfEditorComponent.maxPersistedReusableAssets);
      const existing = prev[duplicateIdx]!;
      const merged = { ...existing, ...next, id: existing.id, createdAt: Date.now() };
      const without = prev.filter((_, i) => i !== duplicateIdx);
      return [merged, ...without].slice(0, PdfEditorComponent.maxPersistedReusableAssets);
    });
    this.persistReusableAssetsToStorage();
  }

  @HostListener('document:pointermove', ['$event'])
  protected onDocPointerMove(ev: PointerEvent) {
    const cropOp = this.activeUploadCropHandle;
    if (cropOp) {
      if (ev.pointerId !== cropOp.pointerId) return;
      const crop = this.imageUploadCropModal();
      const surface = this.uploadCropSurface?.nativeElement;
      if (!crop || !surface) return;
      const rect = surface.getBoundingClientRect();
      const dxPct = rect.width > 0 ? ((ev.clientX - cropOp.startClientX) / rect.width) * 100 : 0;
      const dyPct = rect.height > 0 ? ((ev.clientY - cropOp.startClientY) / rect.height) * 100 : 0;
      const minSpan = 2;
      let leftPct = cropOp.start.leftPct;
      let topPct = cropOp.start.topPct;
      let rightPct = cropOp.start.rightPct;
      let bottomPct = cropOp.start.bottomPct;
      if (cropOp.handle === 'tl') {
        leftPct = clamp(cropOp.start.leftPct + dxPct, 0, 100 - rightPct - minSpan);
        topPct = clamp(cropOp.start.topPct + dyPct, 0, 100 - bottomPct - minSpan);
      } else if (cropOp.handle === 'tr') {
        rightPct = clamp(cropOp.start.rightPct - dxPct, 0, 100 - leftPct - minSpan);
        topPct = clamp(cropOp.start.topPct + dyPct, 0, 100 - bottomPct - minSpan);
      } else if (cropOp.handle === 'bl') {
        leftPct = clamp(cropOp.start.leftPct + dxPct, 0, 100 - rightPct - minSpan);
        bottomPct = clamp(cropOp.start.bottomPct - dyPct, 0, 100 - topPct - minSpan);
      } else {
        rightPct = clamp(cropOp.start.rightPct - dxPct, 0, 100 - leftPct - minSpan);
        bottomPct = clamp(cropOp.start.bottomPct - dyPct, 0, 100 - topPct - minSpan);
      }
      this.imageUploadCropModal.set({
        ...crop,
        leftPct,
        topPct,
        rightPct,
        bottomPct
      });
      return;
    }

    const tdg = this.activeTextDraftGesture;
    if (tdg) {
      if (ev.pointerId !== tdg.pointerId) return;
      const { overlay } = this.getCanvasPair(tdg.pageIndex);
      if (!overlay) return;
      const pt = this.eventToPoint(overlay, ev);
      const { w: rw, h: rh } = this.overlayNominalCssSize(overlay);
      const minW = 120;
      const minH = 40;

      if (tdg.kind === 'move') {
        const { w, h } = this.getTextDraftLayoutSize();
        const dx = pt.x - tdg.startX;
        const dy = pt.y - tdg.startY;
        const ctx = overlay.getContext('2d');
        const obstacles = this.collectPageObstacleRects(tdg.pageIndex, { kind: 'textDraft' }, ctx);
        const ix = clamp(tdg.origX + dx, 0, Math.max(0, rw - w));
        const iy = clamp(tdg.origY + dy, 0, Math.max(0, rh - h));
        const pos = this.constrainAxisMoveNoOverlap(rw, rh, w, h, tdg.origX, tdg.origY, ix, iy, obstacles);
        this.textDraftX.set(pos.x);
        this.textDraftY.set(pos.y);
        this.redrawOverlay(tdg.pageIndex);
        return;
      }

      const o = tdg;
      const ox = o.origX;
      const oy = o.origY;
      const ow = o.origW;
      const oh = o.origH;
      let nx = ox;
      let ny = oy;
      let nw = ow;
      let nh = oh;

      switch (o.edge) {
        case 'e':
          nw = clamp(pt.x - ox, minW, rw - ox);
          break;
        case 's':
          nh = clamp(pt.y - oy, minH, rh - oy);
          break;
        case 'n': {
          const bottom = oy + oh;
          ny = clamp(pt.y, 0, bottom - minH);
          nh = bottom - ny;
          break;
        }
        case 'w': {
          const right = ox + ow;
          nx = clamp(pt.x, 0, right - minW);
          nw = right - nx;
          break;
        }
        case 'se':
          nw = clamp(pt.x - ox, minW, rw - ox);
          nh = clamp(pt.y - oy, minH, rh - oy);
          break;
        case 'sw': {
          const right = ox + ow;
          nx = clamp(pt.x, 0, right - minW);
          nw = right - nx;
          nh = clamp(pt.y - oy, minH, rh - oy);
          break;
        }
        case 'ne': {
          const bottom = oy + oh;
          nw = clamp(pt.x - ox, minW, rw - ox);
          ny = clamp(pt.y, 0, bottom - minH);
          nh = bottom - ny;
          break;
        }
        case 'nw': {
          const right = ox + ow;
          const bottom = oy + oh;
          nx = clamp(pt.x, 0, right - minW);
          nw = right - nx;
          ny = clamp(pt.y, 0, bottom - minH);
          nh = bottom - ny;
          break;
        }
        default:
          break;
      }

      const ctxR = overlay.getContext('2d');
      const obstaclesR = this.collectPageObstacleRects(tdg.pageIndex, { kind: 'textDraft' }, ctxR);
      const origR = { x: o.origX, y: o.origY, w: o.origW, h: o.origH };
      const candR = { x: nx, y: ny, w: nw, h: nh };
      const fin = this.constrainAxisRectLerpNoOverlap(rw, rh, origR, candR, minW, minH, obstaclesR);
      this.textDraftX.set(fin.x);
      this.textDraftY.set(fin.y);
      this.setTextDraftLayoutSize(fin.w, fin.h);
      this.redrawOverlay(tdg.pageIndex);
      return;
    }

    const opT = this.activePlacedTextOp;
    if (opT) {
      if (ev.pointerId !== opT.pointerId) return;
      const { overlay } = this.getCanvasPair(opT.pageIndex);
      if (!overlay) return;
      const pt = this.eventToPoint(overlay, ev);
      const { w: rw, h: rh } = this.overlayNominalCssSize(overlay);
      const ctxT = overlay.getContext('2d');
      const o = opT.orig;
      const minS = 24;
      const scaleFont = (scale: number) => Math.round(clamp(o.fontSize * scale, 6, 200));
      const startAnno = opT.annoStart;

      if (opT.mode === 'move') {
        const dx = pt.x - opT.startX;
        const dy = pt.y - opT.startY;
        const maxX = Math.max(0, rw - o.w);
        const maxY = Math.max(0, rh - o.h);
        const obstacles = this.collectPageObstacleRects(opT.pageIndex, { kind: 'placedText', id: opT.id }, ctxT);
        const pos = this.constrainAxisMoveNoOverlap(
          rw,
          rh,
          o.w,
          o.h,
          o.x,
          o.y,
          clamp(o.x + dx, 0, maxX),
          clamp(o.y + dy, 0, maxY),
          obstacles
        );
        this.updatePlacedText(opT.pageIndex, opT.id, (t) => ({
          ...t,
          x: pos.x,
          y: pos.y
        }));
        this.redrawOverlay(opT.pageIndex);
        return;
      }

      const edge = opT.edge;
      if (edge === 'e') {
        const nw = clamp(o.w + (pt.x - opT.startX), minS, Math.max(minS, rw - o.x));
        const nfs = scaleFont(nw / o.w);
        const candidate = { ...startAnno, fontSize: nfs };
        const applied = this.applyPlacedTextCandidateWithNoOverlap(opT.pageIndex, opT.id, startAnno, candidate, ctxT);
        this.updatePlacedText(opT.pageIndex, opT.id, () => applied);
        this.redrawOverlay(opT.pageIndex);
        return;
      }
      if (edge === 's') {
        const nh = clamp(o.h + (pt.y - opT.startY), minS, Math.max(minS, rh - o.y));
        const nfs = scaleFont(nh / o.h);
        const candidate = { ...startAnno, fontSize: nfs };
        const applied = this.applyPlacedTextCandidateWithNoOverlap(opT.pageIndex, opT.id, startAnno, candidate, ctxT);
        this.updatePlacedText(opT.pageIndex, opT.id, () => applied);
        this.redrawOverlay(opT.pageIndex);
        return;
      }
      if (edge === 'w') {
        const dx = pt.x - opT.startX;
        const nx = o.x + dx;
        const nw0 = o.w - dx;
        const x = clamp(nx, 0, o.x + o.w - minS);
        const ww = clamp(nw0, minS, o.x + o.w - x);
        const nfs = scaleFont(ww / o.w);
        const candidate = { ...startAnno, x, fontSize: nfs };
        const applied = this.applyPlacedTextCandidateWithNoOverlap(opT.pageIndex, opT.id, startAnno, candidate, ctxT);
        this.updatePlacedText(opT.pageIndex, opT.id, () => applied);
        this.redrawOverlay(opT.pageIndex);
        return;
      }
      if (edge === 'n') {
        const dy = pt.y - opT.startY;
        const ny = o.y + dy;
        const nh0 = o.h - dy;
        const y = clamp(ny, 0, o.y + o.h - minS);
        const hh = clamp(nh0, minS, o.y + o.h - y);
        const nfs = scaleFont(hh / o.h);
        const candidate = { ...startAnno, y, fontSize: nfs };
        const applied = this.applyPlacedTextCandidateWithNoOverlap(opT.pageIndex, opT.id, startAnno, candidate, ctxT);
        this.updatePlacedText(opT.pageIndex, opT.id, () => applied);
        this.redrawOverlay(opT.pageIndex);
        return;
      }
      const minRatio = minS / Math.max(o.w, o.h);
      if (edge === 'se') {
        const ratio = clamp(Math.min((pt.x - o.x) / o.w, (pt.y - o.y) / o.h), minRatio, 8);
        const nfs = scaleFont(ratio);
        const candidate = { ...startAnno, fontSize: nfs };
        const applied = this.applyPlacedTextCandidateWithNoOverlap(opT.pageIndex, opT.id, startAnno, candidate, ctxT);
        this.updatePlacedText(opT.pageIndex, opT.id, () => applied);
        this.redrawOverlay(opT.pageIndex);
        return;
      }
      if (edge === 'nw') {
        const ratio = clamp(Math.min((o.x + o.w - pt.x) / o.w, (o.y + o.h - pt.y) / o.h), minRatio, 8);
        const nfs = scaleFont(ratio);
        const nx = o.x + o.w - o.w * ratio;
        const ny = o.y + o.h - o.h * ratio;
        const candidate = {
          ...startAnno,
          x: clamp(nx, 0, rw),
          y: clamp(ny, 0, rh),
          fontSize: nfs
        };
        const applied = this.applyPlacedTextCandidateWithNoOverlap(opT.pageIndex, opT.id, startAnno, candidate, ctxT);
        this.updatePlacedText(opT.pageIndex, opT.id, () => applied);
        this.redrawOverlay(opT.pageIndex);
        return;
      }
      if (edge === 'ne') {
        const ratio = clamp(Math.min((pt.x - o.x) / o.w, (o.y + o.h - pt.y) / o.h), minRatio, 8);
        const nfs = scaleFont(ratio);
        const ny = o.y + o.h - o.h * ratio;
        const candidate = { ...startAnno, y: clamp(ny, 0, rh), fontSize: nfs };
        const applied = this.applyPlacedTextCandidateWithNoOverlap(opT.pageIndex, opT.id, startAnno, candidate, ctxT);
        this.updatePlacedText(opT.pageIndex, opT.id, () => applied);
        this.redrawOverlay(opT.pageIndex);
        return;
      }
      if (edge === 'sw') {
        const ratio = clamp(Math.min((o.x + o.w - pt.x) / o.w, (pt.y - o.y) / o.h), minRatio, 8);
        const nfs = scaleFont(ratio);
        const nx = o.x + o.w - o.w * ratio;
        const candidate = { ...startAnno, x: clamp(nx, 0, rw), fontSize: nfs };
        const applied = this.applyPlacedTextCandidateWithNoOverlap(opT.pageIndex, opT.id, startAnno, candidate, ctxT);
        this.updatePlacedText(opT.pageIndex, opT.id, () => applied);
        this.redrawOverlay(opT.pageIndex);
        return;
      }
      return;
    }

    const opI = this.activePlacedImageOp;
    if (opI) {
      if (ev.pointerId !== opI.pointerId) return;
      const { overlay } = this.getCanvasPair(opI.pageIndex);
      if (!overlay) return;
      const pt = this.eventToPoint(overlay, ev);
      const { w: rw, h: rh } = this.overlayNominalCssSize(overlay);
      const ctxI = overlay.getContext('2d');
      const obstaclesI = this.collectPageObstacleRects(opI.pageIndex, { kind: 'placedImage', id: opI.id }, ctxI);
      const o = opI.orig;
      const minS = 24;

      if (opI.mode === 'move') {
        const dx = pt.x - opI.startX;
        const dy = pt.y - opI.startY;
        const maxX = Math.max(0, rw - o.w);
        const maxY = Math.max(0, rh - o.h);
        const pos = this.constrainAxisMoveNoOverlap(
          rw,
          rh,
          o.w,
          o.h,
          o.x,
          o.y,
          clamp(o.x + dx, 0, maxX),
          clamp(o.y + dy, 0, maxY),
          obstaclesI
        );
        this.beforeFirstPlacedImageMutation(opI, { x: pos.x, y: pos.y, w: o.w, h: o.h });
        this.updatePlacedImage(opI.pageIndex, opI.id, (a) => ({
          ...a,
          x: pos.x,
          y: pos.y
        }));
        this.redrawOverlay(opI.pageIndex);
        return;
      }

      const edge = opI.edge;
      if (edge === 'e') {
        const nw = clamp(
          o.w + (pt.x - opI.startX),
          minS,
          Math.max(minS, rw - o.x)
        );
        const origR = { x: o.x, y: o.y, w: o.w, h: o.h };
        const candR = { x: o.x, y: o.y, w: nw, h: o.h };
        const fin = this.constrainAxisRectLerpNoOverlap(rw, rh, origR, candR, minS, minS, obstaclesI);
        this.beforeFirstPlacedImageMutation(opI, { x: fin.x, y: fin.y, w: fin.w, h: fin.h });
        this.updatePlacedImage(opI.pageIndex, opI.id, (a) => ({ ...a, w: fin.w }));
        this.redrawOverlay(opI.pageIndex);
        return;
      }
      if (edge === 's') {
        const nh = clamp(
          o.h + (pt.y - opI.startY),
          minS,
          Math.max(minS, rh - o.y)
        );
        const origR = { x: o.x, y: o.y, w: o.w, h: o.h };
        const candR = { x: o.x, y: o.y, w: o.w, h: nh };
        const fin = this.constrainAxisRectLerpNoOverlap(rw, rh, origR, candR, minS, minS, obstaclesI);
        this.beforeFirstPlacedImageMutation(opI, { x: fin.x, y: fin.y, w: fin.w, h: fin.h });
        this.updatePlacedImage(opI.pageIndex, opI.id, (a) => ({ ...a, h: fin.h }));
        this.redrawOverlay(opI.pageIndex);
        return;
      }
      if (edge === 'w') {
        const dx = pt.x - opI.startX;
        const nx = o.x + dx;
        const nw0 = o.w - dx;
        const x = clamp(nx, 0, o.x + o.w - minS);
        const w0 = clamp(nw0, minS, o.x + o.w - x);
        const origR = { x: o.x, y: o.y, w: o.w, h: o.h };
        const candR = { x, y: o.y, w: w0, h: o.h };
        const fin = this.constrainAxisRectLerpNoOverlap(rw, rh, origR, candR, minS, minS, obstaclesI);
        this.beforeFirstPlacedImageMutation(opI, { x: fin.x, y: fin.y, w: fin.w, h: fin.h });
        this.updatePlacedImage(opI.pageIndex, opI.id, (a) => ({ ...a, x: fin.x, w: fin.w }));
        this.redrawOverlay(opI.pageIndex);
        return;
      }
      if (edge === 'n') {
        const dy = pt.y - opI.startY;
        const ny = o.y + dy;
        const nh0 = o.h - dy;
        const y = clamp(ny, 0, o.y + o.h - minS);
        const h0 = clamp(nh0, minS, o.y + o.h - y);
        const origR = { x: o.x, y: o.y, w: o.w, h: o.h };
        const candR = { x: o.x, y, w: o.w, h: h0 };
        const fin = this.constrainAxisRectLerpNoOverlap(rw, rh, origR, candR, minS, minS, obstaclesI);
        this.beforeFirstPlacedImageMutation(opI, { x: fin.x, y: fin.y, w: fin.w, h: fin.h });
        this.updatePlacedImage(opI.pageIndex, opI.id, (a) => ({ ...a, y: fin.y, h: fin.h }));
        this.redrawOverlay(opI.pageIndex);
        return;
      }
      if (edge === 'nw') {
        const dx = pt.x - opI.startX;
        const dy = pt.y - opI.startY;
        const nx = o.x + dx;
        const ny = o.y + dy;
        const nw0 = o.w - dx;
        const nh0 = o.h - dy;
        const x = clamp(nx, 0, o.x + o.w - minS);
        const y = clamp(ny, 0, o.y + o.h - minS);
        const ww = clamp(nw0, minS, o.x + o.w - x);
        const hh = clamp(nh0, minS, o.y + o.h - y);
        const origR = { x: o.x, y: o.y, w: o.w, h: o.h };
        const candR = { x, y, w: ww, h: hh };
        const fin = this.constrainAxisRectLerpNoOverlap(rw, rh, origR, candR, minS, minS, obstaclesI);
        this.beforeFirstPlacedImageMutation(opI, { x: fin.x, y: fin.y, w: fin.w, h: fin.h });
        this.updatePlacedImage(opI.pageIndex, opI.id, (a) => ({
          ...a,
          x: fin.x,
          y: fin.y,
          w: fin.w,
          h: fin.h
        }));
        this.redrawOverlay(opI.pageIndex);
        return;
      }
      if (edge === 'ne') {
        const dy = pt.y - opI.startY;
        const ny = o.y + dy;
        const nh0 = o.h - dy;
        const y = clamp(ny, 0, o.y + o.h - minS);
        const hh = clamp(nh0, minS, o.y + o.h - y);
        const nw = clamp(o.w + (pt.x - opI.startX), minS, Math.max(minS, rw - o.x));
        const origR = { x: o.x, y: o.y, w: o.w, h: o.h };
        const candR = { x: o.x, y, w: nw, h: hh };
        const fin = this.constrainAxisRectLerpNoOverlap(rw, rh, origR, candR, minS, minS, obstaclesI);
        this.beforeFirstPlacedImageMutation(opI, { x: fin.x, y: fin.y, w: fin.w, h: fin.h });
        this.updatePlacedImage(opI.pageIndex, opI.id, (a) => ({ ...a, y: fin.y, w: fin.w, h: fin.h }));
        this.redrawOverlay(opI.pageIndex);
        return;
      }
      if (edge === 'sw') {
        const dx = pt.x - opI.startX;
        const nx = o.x + dx;
        const nw0 = o.w - dx;
        const x = clamp(nx, 0, o.x + o.w - minS);
        const ww = clamp(nw0, minS, o.x + o.w - x);
        const nh = clamp(o.h + (pt.y - opI.startY), minS, Math.max(minS, rh - o.y));
        const origR = { x: o.x, y: o.y, w: o.w, h: o.h };
        const candR = { x, y: o.y, w: ww, h: nh };
        const fin = this.constrainAxisRectLerpNoOverlap(rw, rh, origR, candR, minS, minS, obstaclesI);
        this.beforeFirstPlacedImageMutation(opI, { x: fin.x, y: fin.y, w: fin.w, h: fin.h });
        this.updatePlacedImage(opI.pageIndex, opI.id, (a) => ({ ...a, x: fin.x, w: fin.w, h: fin.h }));
        this.redrawOverlay(opI.pageIndex);
        return;
      }
      if (edge === 'se') {
        const nw = clamp(
          o.w + (pt.x - opI.startX),
          minS,
          Math.max(minS, rw - o.x)
        );
        const nh = clamp(
          o.h + (pt.y - opI.startY),
          minS,
          Math.max(minS, rh - o.y)
        );
        const origR = { x: o.x, y: o.y, w: o.w, h: o.h };
        const candR = { x: o.x, y: o.y, w: nw, h: nh };
        const fin = this.constrainAxisRectLerpNoOverlap(rw, rh, origR, candR, minS, minS, obstaclesI);
        this.beforeFirstPlacedImageMutation(opI, { x: fin.x, y: fin.y, w: fin.w, h: fin.h });
        this.updatePlacedImage(opI.pageIndex, opI.id, (a) => ({ ...a, w: fin.w, h: fin.h }));
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
    const { w: rw, h: rh } = this.overlayNominalCssSize(overlay);
    const ctxW = overlay.getContext('2d');
    const obstaclesW = this.collectPageObstacleRects(op.pageIndex, { kind: 'widget', id: op.id }, ctxW);

    if (op.mode === 'move') {
      const dx = pt.x - op.startX;
      const dy = pt.y - op.startY;
      const maxX = Math.max(0, rw - op.origW);
      const maxY = Math.max(0, rh - op.origH);
      const pos = this.constrainAxisMoveNoOverlap(
        rw,
        rh,
        op.origW,
        op.origH,
        op.origX,
        op.origY,
        clamp(op.origX + dx, 0, maxX),
        clamp(op.origY + dy, 0, maxY),
        obstaclesW
      );
      this.updateWidget(op.pageIndex, op.id, (w) => ({
        ...w,
        x: pos.x,
        y: pos.y
      }));
      return;
    }

    const o = { x: op.origX, y: op.origY, w: op.origW, h: op.origH };
    const dx = pt.x - op.startX;
    const dy = pt.y - op.startY;
    const minW = 80;
    const minH = 60;
    const edge = op.resizeEdge ?? 'se';
    const edgeKind = edge === 'br' ? 'se' : edge;

    if (edgeKind === 'se' || edge === 'br') {
      const maxWb = Math.max(minW, rw - o.x);
      const maxHb = Math.max(minH, rh - o.y);
      const cw = clamp(o.w + dx, minW, maxWb);
      const ch = clamp(o.h + dy, minH, maxHb);
      const origR = { x: o.x, y: o.y, w: o.w, h: o.h };
      const candR = { x: o.x, y: o.y, w: cw, h: ch };
      const fin = this.constrainAxisRectLerpNoOverlap(rw, rh, origR, candR, minW, minH, obstaclesW);
      this.updateWidget(op.pageIndex, op.id, (w) => ({
        ...w,
        w: fin.w,
        h: fin.h
      }));
      return;
    }

    if (edgeKind === 'nw') {
      const nx = o.x + dx;
      const ny = o.y + dy;
      const nw0 = o.w - dx;
      const nh0 = o.h - dy;
      const x = clamp(nx, 0, o.x + o.w - minW);
      const y = clamp(ny, 0, o.y + o.h - minH);
      const ww = clamp(nw0, minW, o.x + o.w - x);
      const hh = clamp(nh0, minH, o.y + o.h - y);
      const origR = { x: o.x, y: o.y, w: o.w, h: o.h };
      const candR = { x, y, w: ww, h: hh };
      const fin = this.constrainAxisRectLerpNoOverlap(rw, rh, origR, candR, minW, minH, obstaclesW);
      this.updateWidget(op.pageIndex, op.id, (w) => ({
        ...w,
        x: fin.x,
        y: fin.y,
        w: fin.w,
        h: fin.h
      }));
      return;
    }

    if (edgeKind === 'ne') {
      const ny = o.y + dy;
      const nh0 = o.h - dy;
      const y = clamp(ny, 0, o.y + o.h - minH);
      const hh = clamp(nh0, minH, o.y + o.h - y);
      const nw = clamp(o.w + dx, minW, Math.max(minW, rw - o.x));
      const origR = { x: o.x, y: o.y, w: o.w, h: o.h };
      const candR = { x: o.x, y, w: nw, h: hh };
      const fin = this.constrainAxisRectLerpNoOverlap(rw, rh, origR, candR, minW, minH, obstaclesW);
      this.updateWidget(op.pageIndex, op.id, (w) => ({
        ...w,
        y: fin.y,
        w: fin.w,
        h: fin.h
      }));
      return;
    }

    if (edgeKind === 'sw') {
      const nx = o.x + dx;
      const nw0 = o.w - dx;
      const x = clamp(nx, 0, o.x + o.w - minW);
      const ww = clamp(nw0, minW, o.x + o.w - x);
      const nh = clamp(o.h + dy, minH, Math.max(minH, rh - o.y));
      const origR = { x: o.x, y: o.y, w: o.w, h: o.h };
      const candR = { x, y: o.y, w: ww, h: nh };
      const fin = this.constrainAxisRectLerpNoOverlap(rw, rh, origR, candR, minW, minH, obstaclesW);
      this.updateWidget(op.pageIndex, op.id, (w) => ({
        ...w,
        x: fin.x,
        w: fin.w,
        h: fin.h
      }));
      return;
    }

    if (edge === 'e') {
      const nw = clamp(
        o.w + dx,
        minW,
        Math.max(minW, rw - o.x)
      );
      const origR = { x: o.x, y: o.y, w: o.w, h: o.h };
      const candR = { x: o.x, y: o.y, w: nw, h: o.h };
      const fin = this.constrainAxisRectLerpNoOverlap(rw, rh, origR, candR, minW, minH, obstaclesW);
      this.updateWidget(op.pageIndex, op.id, (w) => ({ ...w, w: fin.w }));
      return;
    }
    if (edge === 's') {
      const nh = clamp(
        o.h + dy,
        minH,
        Math.max(minH, rh - o.y)
      );
      const origR = { x: o.x, y: o.y, w: o.w, h: o.h };
      const candR = { x: o.x, y: o.y, w: o.w, h: nh };
      const fin = this.constrainAxisRectLerpNoOverlap(rw, rh, origR, candR, minW, minH, obstaclesW);
      this.updateWidget(op.pageIndex, op.id, (w) => ({ ...w, h: fin.h }));
      return;
    }
    if (edge === 'w') {
      const nx = o.x + dx;
      const nw0 = o.w - dx;
      const x = clamp(nx, 0, o.x + o.w - minW);
      const ww = clamp(nw0, minW, o.x + o.w - x);
      const origR = { x: o.x, y: o.y, w: o.w, h: o.h };
      const candR = { x, y: o.y, w: ww, h: o.h };
      const fin = this.constrainAxisRectLerpNoOverlap(rw, rh, origR, candR, minW, minH, obstaclesW);
      this.updateWidget(op.pageIndex, op.id, (w) => ({ ...w, x: fin.x, w: fin.w }));
      return;
    }
    if (edge === 'n') {
      const ny = o.y + dy;
      const nh0 = o.h - dy;
      const y = clamp(ny, 0, o.y + o.h - minH);
      const hh = clamp(nh0, minH, o.y + o.h - y);
      const origR = { x: o.x, y: o.y, w: o.w, h: o.h };
      const candR = { x: o.x, y, w: o.w, h: hh };
      const fin = this.constrainAxisRectLerpNoOverlap(rw, rh, origR, candR, minW, minH, obstaclesW);
      this.updateWidget(op.pageIndex, op.id, (w) => ({ ...w, y: fin.y, h: fin.h }));
      return;
    }
  }

  @HostListener('document:pointerup', ['$event'])
  protected onDocPointerUp(ev: PointerEvent) {
    const cropOp = this.activeUploadCropHandle;
    if (cropOp) {
      if (ev.pointerId !== cropOp.pointerId) return;
      this.activeUploadCropHandle = null;
      return;
    }

    const tdgUp = this.activeTextDraftGesture;
    if (tdgUp) {
      if (ev.pointerId !== tdgUp.pointerId) return;
      this.activeTextDraftGesture = null;
      const pi = tdgUp.pageIndex;
      this.redrawOverlay(pi);
      queueMicrotask(() => {
        if (this.isTextPlacing() && this.textDraftPageIndex() === pi) {
          this.textDraftEditor?.nativeElement?.focus({ preventScroll: true });
        }
      });
      return;
    }

    const opTUp = this.activePlacedTextOp;
    if (opTUp) {
      if (ev.pointerId !== opTUp.pointerId) return;
      this.activePlacedTextOp = null;
      this.redrawOverlay(opTUp.pageIndex);
      return;
    }

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

  protected bringSelectedWidgetForward(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    const sel = this.selectedItemWidget();
    if (!sel) return;
    const { pageIndex, widget } = sel;
    this.widgetsByPage.update((prev) => {
      const cur = prev[pageIndex] ?? [];
      const i = cur.findIndex((w) => w.id === widget.id);
      if (i < 0 || i >= cur.length - 1) return prev;
      const next = cur.slice();
      const tmp = next[i]!;
      next[i] = next[i + 1]!;
      next[i + 1] = tmp;
      return { ...prev, [pageIndex]: next };
    });
  }

  protected sendSelectedWidgetBackward(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    const sel = this.selectedItemWidget();
    if (!sel) return;
    const { pageIndex, widget } = sel;
    this.widgetsByPage.update((prev) => {
      const cur = prev[pageIndex] ?? [];
      const i = cur.findIndex((w) => w.id === widget.id);
      if (i <= 0) return prev;
      const next = cur.slice();
      const tmp = next[i]!;
      next[i] = next[i - 1]!;
      next[i - 1] = tmp;
      return { ...prev, [pageIndex]: next };
    });
  }

  protected canBringSelectedWidgetForward(): boolean {
    const sel = this.selectedItemWidget();
    if (!sel) return false;
    const list = this.widgetsByPage()[sel.pageIndex] ?? [];
    const i = list.findIndex((w) => w.id === sel.widget.id);
    return i >= 0 && i < list.length - 1;
  }

  protected canSendSelectedWidgetBackward(): boolean {
    const sel = this.selectedItemWidget();
    if (!sel) return false;
    const list = this.widgetsByPage()[sel.pageIndex] ?? [];
    const i = list.findIndex((w) => w.id === sel.widget.id);
    return i > 0;
  }

  protected async addBlankPageAfter(pageIndex: number) {
    await this.mutatePdfPages(
      async (pdf) => {
        const insertAt = clamp(pageIndex + 1, 0, pdf.getPageCount());
        const count = pdf.getPageCount();
        if (count <= 0) {
          pdf.insertPage(insertAt, [595.28, 841.89]);
          return;
        }
        const srcIndex = clamp(pageIndex, 0, count - 1);
        // Inherit PDF-native header/footer (and margins) from the prior slide so layout matches
        // template artwork; wipe the middle band so body content is not duplicated.
        const [copied] = await pdf.copyPages(pdf, [srcIndex]);
        pdf.insertPage(insertAt, copied);
        const newPage = pdf.getPage(insertAt);
        const { width, height } = newPage.getSize();
        const band = Math.min(140, Math.max(48, height * 0.095));
        const bodyHeight = Math.max(1, height - 2 * band);
        newPage.drawRectangle({
          x: 0,
          y: band,
          width,
          height: bodyHeight,
          color: rgb(1, 1, 1)
        });
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

  protected async addSlideFromTemplate(afterPageIndex: number, templateProposalId: string, templatePageIndex = 0) {
    const cleanTemplateId = String(templateProposalId || '').trim();
    if (!cleanTemplateId) return;
    await this.mutatePdfPages(
      async (pdf) => {
        const templateBytes = await this.api.getBytes(cleanTemplateId);
        const templatePdf = await PDFDocument.load(new Uint8Array(templateBytes));
        const srcIndex = clamp(templatePageIndex, 0, Math.max(0, templatePdf.getPageCount() - 1));
        const [copied] = await pdf.copyPages(templatePdf, [srcIndex]);
        const insertAt = clamp(afterPageIndex + 1, 0, pdf.getPageCount());
        pdf.insertPage(insertAt, copied);
      },
      { kind: 'insert', at: afterPageIndex + 1 }
    );
    this.setActivePage(afterPageIndex + 1);
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
    this.busyHint.set('Reordering slides…');
    this.isLoading.set(true);
    await this.yieldForUiPaint();

    try {
      this.assertReadablePdfHeader(this.pdfBytes);
      this.cancelAllPdfRenderTasks();
      ++this.renderAllPagesEpoch;
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
      this.sectionOverridesByPage.set(this.remapKeyedBySlideReorder(this.sectionOverridesByPage(), reorder));
      this.removedSectionsByPage.set(this.remapKeyedBySlideReorder(this.removedSectionsByPage(), reorder));

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
      this.detectedMediaByPage.set({});
      this.baseSnapshotByPage.clear();
      this.cancelAllPdfRenderTasks();
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
      await this.generateAllPageThumbnails();
      void this.primeSidebarSectionDetection();
      this.showSlideToast('Slides reordered');
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to reorder slides.');
    } finally {
      this.isLoading.set(false);
      this.busyHint.set('Working…');
    }
  }

  /**
   * Reorder PDF pages using an explicit permutation.
   * `reorder[newIndex] === oldIndex`.
   */
  private async reorderPagesInDocumentByOrder(reorder: number[]) {
    if (!this.pdfBytes) return;
    if (this.isLoading() || this.isSaving()) return;

    const count = this.pageCount();
    if (!Array.isArray(reorder) || reorder.length !== count) return;

    const seen = new Set<number>();
    for (const idx of reorder) {
      if (!Number.isFinite(idx) || idx < 0 || idx >= count) return;
      seen.add(idx);
    }
    if (seen.size !== count) return;

    const prevActive = this.activePageIndex();
    this.errorText.set(null);
    this.openPageMenuIndex.set(null);
    this.sidebarSlideMenuOpenIndex.set(null);
    this.slideDragFromIndex.set(null);
    this.slideDropHoverIndex.set(null);
    this.busyHint.set('Reordering slides…');
    this.isLoading.set(true);
    await this.yieldForUiPaint();

    try {
      this.assertReadablePdfHeader(this.pdfBytes);
      this.cancelAllPdfRenderTasks();
      ++this.renderAllPagesEpoch;
      const srcPdf = await PDFDocument.load(this.clonePdfBytes(this.pdfBytes));
      const outPdf = await PDFDocument.create();
      const copied = await outPdf.copyPages(srcPdf, reorder);
      for (const p of copied) outPdf.addPage(p);
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
      this.sectionOverridesByPage.set(this.remapKeyedBySlideReorder(this.sectionOverridesByPage(), reorder));
      this.removedSectionsByPage.set(this.remapKeyedBySlideReorder(this.removedSectionsByPage(), reorder));

      const nextRot = new Map<number, number>();
      for (let newIdx = 0; newIdx < reorder.length; newIdx++) {
        const oldIdx = reorder[newIdx]!;
        const rot = this.pageRotateByPage.get(oldIdx);
        if (rot !== undefined) nextRot.set(newIdx, rot);
      }
      this.pageRotateByPage.clear();
      for (const [k, v] of nextRot) this.pageRotateByPage.set(k, v);

      this.pageThumbUrlByPage.set({});
      this.detectedTextByPage.set({});
      this.detectedBlocksByPage.set({});
      this.detectedMediaByPage.set({});
      this.baseSnapshotByPage.clear();
      this.cancelAllPdfRenderTasks();
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
      await this.generateAllPageThumbnails();
      void this.primeSidebarSectionDetection();
      this.showSlideToast('Key slots reordered');
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to reorder key slots.');
    } finally {
      this.isLoading.set(false);
      this.busyHint.set('Working…');
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

  private reindexKeyedByInsertedPage<T>(prev: Record<number, T>, insertedAt: number): Record<number, T> {
    const next: Record<number, T> = {};
    for (const [k, v] of Object.entries(prev)) {
      const idx = Number(k);
      if (!Number.isFinite(idx) || !v) continue;
      next[idx >= insertedAt ? idx + 1 : idx] = v as T;
    }
    return next;
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

  private remapSectionMetaAfterInsert(atIndex: number) {
    this.sectionOverridesByPage.set(this.reindexKeyedByInsertedPage(this.sectionOverridesByPage(), atIndex));
    this.removedSectionsByPage.set(this.reindexKeyedByInsertedPage(this.removedSectionsByPage(), atIndex));
  }

  private remapSectionMetaAfterDelete(atIndex: number) {
    this.sectionOverridesByPage.set(this.reindexKeyedByDeletedPage(this.sectionOverridesByPage(), atIndex));
    this.removedSectionsByPage.set(this.reindexKeyedByDeletedPage(this.removedSectionsByPage(), atIndex));
  }

  private remapSectionMetaAfterCopy(fromIndex: number, toIndex: number) {
    const prevOverrides = this.sectionOverridesByPage();
    this.sectionOverridesByPage.set(this.reindexKeyedByInsertedPage(prevOverrides, toIndex));
    this.removedSectionsByPage.set(this.reindexKeyedByInsertedPage(this.removedSectionsByPage(), toIndex));
    const copied = prevOverrides[fromIndex];
    if (copied) {
      this.sectionOverridesByPage.update((prev) => ({
        ...prev,
        [toIndex]: copied
      }));
    }
  }

  private async yieldForUiPaint(): Promise<void> {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }

  private cloneImageData(src: ImageData): ImageData {
    return new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
  }

  private reindexSnapshotMapAfterInsert(map: Map<number, ImageData>, insertedAt: number) {
    const next = new Map<number, ImageData>();
    for (const [k, v] of map) {
      next.set(k >= insertedAt ? k + 1 : k, v);
    }
    map.clear();
    for (const [k, v] of next) map.set(k, v);
    map.delete(insertedAt);
  }

  private reindexSnapshotMapAfterDelete(map: Map<number, ImageData>, deletedAt: number) {
    const next = new Map<number, ImageData>();
    for (const [k, v] of map) {
      if (k === deletedAt) continue;
      next.set(k > deletedAt ? k - 1 : k, v);
    }
    map.clear();
    for (const [k, v] of next) map.set(k, v);
  }

  private duplicatePageSnapshot(map: Map<number, ImageData>, fromIndex: number, toIndex: number) {
    const src = map.get(fromIndex);
    if (src) map.set(toIndex, this.cloneImageData(src));
  }

  private reindexRotateMapAfterInsert(insertedAt: number) {
    const next = new Map<number, number>();
    for (const [k, v] of this.pageRotateByPage) {
      next.set(k >= insertedAt ? k + 1 : k, v);
    }
    this.pageRotateByPage.clear();
    for (const [k, v] of next) this.pageRotateByPage.set(k, v);
    this.pageRotateByPage.delete(insertedAt);
  }

  private reindexRotateMapAfterDelete(deletedAt: number) {
    const next = new Map<number, number>();
    for (const [k, v] of this.pageRotateByPage) {
      if (k === deletedAt) continue;
      next.set(k > deletedAt ? k - 1 : k, v);
    }
    this.pageRotateByPage.clear();
    for (const [k, v] of next) this.pageRotateByPage.set(k, v);
  }

  private reindexThumbUrlsAfterInsert(prev: Record<number, string>, at: number): Record<number, string> {
    const next: Record<number, string> = {};
    for (const [k, v] of Object.entries(prev)) {
      const idx = Number(k);
      if (!Number.isFinite(idx) || !v) continue;
      next[idx >= at ? idx + 1 : idx] = v;
    }
    return next;
  }

  private reindexThumbUrlsAfterDelete(prev: Record<number, string>, at: number): Record<number, string> {
    const next: Record<number, string> = {};
    for (const [k, v] of Object.entries(prev)) {
      const idx = Number(k);
      if (!Number.isFinite(idx) || !v) continue;
      if (idx === at) continue;
      next[idx > at ? idx - 1 : idx] = v;
    }
    return next;
  }

  private remapThumbUrlsAfterCopy(prev: Record<number, string>, fromIndex: number, toIndex: number): Record<number, string> {
    const next: Record<number, string> = {};
    for (const [k, v] of Object.entries(prev)) {
      const idx = Number(k);
      if (!Number.isFinite(idx) || !v) continue;
      next[idx >= toIndex ? idx + 1 : idx] = v;
    }
    const src = prev[fromIndex];
    if (src) next[toIndex] = src;
    return next;
  }

  private remapDetectedAfterCopy(fromIndex: number, toIndex: number) {
    const prevText = this.detectedTextByPage();
    const prevBlocks = this.detectedBlocksByPage();
    const prevMedia = this.detectedMediaByPage();
    const nextText: Record<number, DetectedText[]> = {};
    const nextBlocks: Record<number, DetectedBlock[]> = {};
    const nextMedia: Record<number, DetectedPdfMedia[]> = {};
    for (const [k, v] of Object.entries(prevText)) {
      const idx = Number(k);
      if (!Number.isFinite(idx) || !v) continue;
      nextText[idx >= toIndex ? idx + 1 : idx] = v.map((t) => ({ ...t }));
    }
    for (const [k, v] of Object.entries(prevBlocks)) {
      const idx = Number(k);
      if (!Number.isFinite(idx) || !v) continue;
      nextBlocks[idx >= toIndex ? idx + 1 : idx] = v.map((b) => ({ ...b }));
    }
    for (const [k, v] of Object.entries(prevMedia)) {
      const idx = Number(k);
      if (!Number.isFinite(idx) || !v) continue;
      nextMedia[idx >= toIndex ? idx + 1 : idx] = v.map((m) => ({ ...m }));
    }
    const srcText = prevText[fromIndex] ?? [];
    const srcBlocks = prevBlocks[fromIndex] ?? [];
    const srcMedia = prevMedia[fromIndex] ?? [];
    nextText[toIndex] = srcText.map((t) => ({ ...t }));
    nextBlocks[toIndex] = srcBlocks.map((b) => ({ ...b }));
    nextMedia[toIndex] = srcMedia.map((m) => ({ ...m }));
    this.detectedTextByPage.set(nextText);
    this.detectedBlocksByPage.set(nextBlocks);
    this.detectedMediaByPage.set(nextMedia);
  }

  private newWidgetId(): string {
    return `w_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  }

  private cloneWidgetForDuplicatePage(w: Widget): Widget {
    const id = this.newWidgetId();
    return { ...w, id };
  }

  private remapWidgetsAfterCopy(fromIndex: number, toIndex: number) {
    const prev = this.widgetsByPage();
    const next: Record<number, Widget[]> = {};
    for (const [k, v] of Object.entries(prev)) {
      const idx = Number(k);
      if (!Number.isFinite(idx) || !v) continue;
      next[idx >= toIndex ? idx + 1 : idx] = v;
    }
    const src = prev[fromIndex] ?? [];
    next[toIndex] = src.map((w) => this.cloneWidgetForDuplicatePage(w));
    this.widgetsByPage.set(next);
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
    this.busyHint.set('Updating slides…');
    this.isLoading.set(true);
    this.openPageMenuIndex.set(null);
    this.sidebarSlideMenuOpenIndex.set(null);
    await this.yieldForUiPaint();

    try {
      this.assertReadablePdfHeader(this.pdfBytes);
      this.cancelAllPdfRenderTasks();
      ++this.renderAllPagesEpoch;
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

      if (remap.kind === 'insert') {
        this.remapEditsAfterInsert(remap.at);
        this.remapSectionMetaAfterInsert(remap.at);
        this.widgetsByPage.set(this.reindexKeyedByInsertedPage(this.widgetsByPage(), remap.at));
        this.pageThumbUrlByPage.set(this.reindexThumbUrlsAfterInsert(this.pageThumbUrlByPage(), remap.at));
        this.detectedTextByPage.set(this.reindexKeyedByInsertedPage(this.detectedTextByPage(), remap.at));
        this.detectedBlocksByPage.set(this.reindexKeyedByInsertedPage(this.detectedBlocksByPage(), remap.at));
        this.detectedMediaByPage.set(this.reindexKeyedByInsertedPage(this.detectedMediaByPage(), remap.at));
        this.reindexSnapshotMapAfterInsert(this.baseSnapshotByPage, remap.at);
        this.reindexRotateMapAfterInsert(remap.at);
      }
      if (remap.kind === 'delete') {
        this.remapEditsAfterDelete(remap.at);
        this.widgetsByPage.set(this.reindexKeyedByDeletedPage(this.widgetsByPage(), remap.at));
        this.remapSectionMetaAfterDelete(remap.at);
        this.pageThumbUrlByPage.set(this.reindexThumbUrlsAfterDelete(this.pageThumbUrlByPage(), remap.at));
        this.detectedTextByPage.set(this.reindexKeyedByDeletedPage(this.detectedTextByPage(), remap.at));
        this.detectedBlocksByPage.set(this.reindexKeyedByDeletedPage(this.detectedBlocksByPage(), remap.at));
        this.detectedMediaByPage.set(this.reindexKeyedByDeletedPage(this.detectedMediaByPage(), remap.at));
        this.reindexSnapshotMapAfterDelete(this.baseSnapshotByPage, remap.at);
        this.reindexRotateMapAfterDelete(remap.at);
      }
      if (remap.kind === 'copy') {
        const fromRot = this.pageRotateByPage.get(remap.from);
        this.remapEditsAfterCopy(remap.from, remap.to);
        this.remapSectionMetaAfterCopy(remap.from, remap.to);
        this.remapWidgetsAfterCopy(remap.from, remap.to);
        this.pageThumbUrlByPage.set(this.remapThumbUrlsAfterCopy(this.pageThumbUrlByPage(), remap.from, remap.to));
        this.remapDetectedAfterCopy(remap.from, remap.to);
        this.reindexSnapshotMapAfterInsert(this.baseSnapshotByPage, remap.to);
        this.duplicatePageSnapshot(this.baseSnapshotByPage, remap.from, remap.to);
        this.reindexRotateMapAfterInsert(remap.to);
        if (fromRot !== undefined) this.pageRotateByPage.set(remap.to, fromRot);
      }

      this.cancelAllPdfRenderTasks();
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
      await this.generateAllPageThumbnails();
      if (remap.kind === 'insert') {
        await this.detectBlocksForPage(remap.at);
      }
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to update PDF pages.');
    } finally {
      this.isLoading.set(false);
      this.busyHint.set('Working…');
    }
  }

  private async renderPageThumbnailIfMissing(pageIndex: number, epoch: number): Promise<void> {
    if (!this.pdfDoc) return;
    if (epoch !== this.thumbsEpoch) return;
    if (this.pageThumbUrlByPage()[pageIndex]) return;
    try {
      const page = await this.pdfDoc.getPage(pageIndex + 1);
      const rotation = (((page.rotate ?? 0) % 360) + 360) % 360;
      const viewport = page.getViewport({ scale: 0.18, rotation: rotation === 180 ? 0 : rotation });
      const canvas = document.createElement('canvas');
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
      await page.render({ canvasContext: ctx, viewport, transform, canvas }).promise;
      const url = canvas.toDataURL('image/jpeg', 0.6);
      if (epoch !== this.thumbsEpoch) return;
      this.pageThumbUrlByPage.update((prev) => ({ ...prev, [pageIndex]: url }));
    } catch {
      // ignore thumbnail failures (page still usable)
    }
  }

  private async generateAllPageThumbnails() {
    if (!this.pdfDoc) return;
    const epoch = ++this.thumbsEpoch;
    const count = this.pageCount();
    if (count <= 0) return;

    for (let pageIndex = 0; pageIndex < count; pageIndex++) {
      if (epoch !== this.thumbsEpoch) return;
      await this.renderPageThumbnailIfMissing(pageIndex, epoch);
    }
  }

  /** Fast path for open/upload: render sidebar thumbs near the active page first, then the rest in the background. */
  private generateNearThumbnailsThenRest(radius = 5): void {
    if (!this.pdfDoc) return;
    const epoch = ++this.thumbsEpoch;
    const count = this.pageCount();
    if (count <= 0) return;
    const a = clamp(this.activePageIndex(), 0, count - 1);
    const near = new Set<number>();
    for (let d = -radius; d <= radius; d++) {
      const i = a + d;
      if (i >= 0 && i < count) near.add(i);
    }
    void (async () => {
      try {
        for (const i of near) {
          if (epoch !== this.thumbsEpoch) return;
          await this.renderPageThumbnailIfMissing(i, epoch);
        }
      } catch {
        // ignore
      }
      void this.finishRemainingThumbnails(epoch, count, near);
    })();
  }

  private async finishRemainingThumbnails(epoch: number, count: number, skip: Set<number>): Promise<void> {
    try {
      for (let pageIndex = 0; pageIndex < count; pageIndex++) {
        if (skip.has(pageIndex)) continue;
        if (epoch !== this.thumbsEpoch) return;
        await this.renderPageThumbnailIfMissing(pageIndex, epoch);
      }
    } catch {
      // ignore
    }
  }

  private sanitizeSidebarTitle(text: string): string {
    const compact = text.replace(/\s+/g, ' ').trim();
    if (!compact) return '';
    return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
  }

  /** True when the string is only an outline index (no real title words). */
  private isSidebarTitleTrivial(text: string): boolean {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t) return true;
    if (/^\d+([.)]\d+)*\.?$/.test(t)) return true;
    if (/^[ivxlcdm]{1,8}\.?$/i.test(t)) return true;
    return /^[\d.)\s]+$/.test(t) && /\d/.test(t);
  }

  /** Remove leading "1.", "Section 2", bullets, or a lone outline token so we can read the real title. */
  private stripSidebarEnumeratingPrefix(text: string): string {
    let t = text.replace(/\s+/g, ' ').trim();
    const before = t;
    t = t
      .replace(/^\s*(?:section|part|chapter)\s+\d+(?:[.:)]\d+)*\s*/i, '')
      .replace(/^\s*\d+(?:[.)]\d+)*[.)]\s+/, '')
      .replace(/^\s*[-•]\s+/, '')
      .trim();
    if (t !== before) return t;
    if (/^\s*\d+(?:[.)]\d+)*[.)]?\s*$/.test(t)) return '';
    return t;
  }

  private coalesceSidebarTitleFromBlockText(raw: string): string {
    const t = this.sanitizeSidebarTitle(raw);
    if (!t) return '';

    const stripped = this.stripSidebarEnumeratingPrefix(t);
    let body: string;
    if (stripped !== t) {
      body = stripped ? this.sanitizeSidebarTitle(stripped) : '';
    } else {
      body = t;
    }
    if (!body || this.isSidebarTitleTrivial(body)) return '';
    if (/^\d+\s*\/\s*\d+(?:\s*\/\s*\d+)*$/.test(body)) return '';
    return body;
  }

  private resolveSidebarSectionMeta(blocks: DetectedBlock[]): { title: string; type: SidebarSectionType } | null {
    if (blocks.length === 0) return null;

    const headingLike = blocks
      .filter((b) => !!this.sanitizeSidebarTitle(b.text))
      .sort((a, b) => (a.y - b.y) || (b.fontSize - a.fontSize));

    const preferHeadings = [
      ...headingLike.filter((b) => b.kind === 'heading'),
      ...headingLike.filter((b) => b.kind !== 'heading')
    ];

    for (const cand of preferHeadings) {
      const title = this.coalesceSidebarTitleFromBlockText(cand.text);
      if (!title) continue;

      const nearTop = cand.y < 180;
      const hasOnlyFewTextBlocks = headingLike.length <= 2;
      const shortHeadline = title.length <= 60;
      const type: SidebarSectionType =
        nearTop && hasOnlyFewTextBlocks && shortHeadline ? 'imageHeader' : 'section';

      return { title, type };
    }
    return null;
  }

  private async primeSidebarSectionDetection() {
    if (!this.pdfDoc) return;
    const epoch = ++this.sidebarSectionDetectEpoch;
    const count = this.pageCount();
    for (let pageIndex = 0; pageIndex < count; pageIndex++) {
      if (epoch !== this.sidebarSectionDetectEpoch) return;
      if ((this.detectedBlocksByPage()[pageIndex] ?? []).length > 0) continue;
      try {
        await this.detectBlocksForPage(pageIndex);
      } catch {
        // keep sidebar usable even if detection fails for some pages
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
    // Clicks on the PDF canvas do not always blur the floating textarea first; without
    // this flush, starting a new placement or hit-target would discard the draft.
    const closingFloatingTextDraft = this.isTextPlacing() && !this.activeTextDraftGesture;
    if (closingFloatingTextDraft) {
      this.commitTextDraft();
    }
    this.flushInlineWidgetTextEditors(pageIndex);

    const pending = this.insertWidgetPending();
    if (pending) {
      const { overlay } = this.getCanvasPair(pageIndex);
      if (!overlay) return;
      const p = this.eventToPoint(overlay, ev);
      this.addWidgetAtPoint(pageIndex, pending.kind, p.x, p.y);
      this.insertWidgetPending.set(null);
      this.isInserting.set(false);
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }

    if (this.tool() !== 'pen') {
      const { overlay } = this.getCanvasPair(pageIndex);
      if (overlay) {
        const p = this.eventToPoint(overlay, ev);
        const textHit = this.hitTestPlacedText(pageIndex, p.x, p.y);
        if (textHit) {
          if (textHit.part === 'close') {
            if (!this.readonlyMode()) {
              this.removePlacedTextAnno(pageIndex, textHit.id);
            }
            ev.preventDefault();
            ev.stopPropagation();
            return;
          }
          const tAnno = this.getPlacedTextAnno(pageIndex, textHit.id);
          if (!tAnno) {
            ev.preventDefault();
            ev.stopPropagation();
            return;
          }
          this.selectedWidgetId.set(null);
          this.selectedDetectedPdfMedia.set(null);
          this.selectedPlacedImageId.set(null);
          this.selectedPlacedTextId.set(textHit.id);
          if (this.readonlyMode()) {
            ev.preventDefault();
            ev.stopPropagation();
            this.redrawOverlay(pageIndex);
            return;
          }
          this.beginHistoryStep();
          const ctx = overlay.getContext('2d');
          const b = ctx ? this.measureTextAnnoBounds(ctx, tAnno) : { x: tAnno.x, y: tAnno.y, w: 40, h: tAnno.fontSize };
          (ev.currentTarget as HTMLCanvasElement | null)?.setPointerCapture?.(ev.pointerId);
          this.activePlacedTextOp = {
            pageIndex,
            id: textHit.id,
            pointerId: ev.pointerId,
            mode: textHit.part === 'body' ? 'move' : 'resize',
            edge: textHit.part === 'body' ? null : textHit.part,
            startX: p.x,
            startY: p.y,
            annoStart: { ...tAnno },
            orig: { x: tAnno.x, y: tAnno.y, w: b.w, h: b.h, fontSize: tAnno.fontSize }
          };
          ev.preventDefault();
          ev.stopPropagation();
          this.redrawOverlay(pageIndex);
          return;
        }

        const hit = this.hitTestPlacedImage(pageIndex, p.x, p.y);
        if (hit) {
          const anno = this.getImageAnno(pageIndex, hit.id);
          if (!anno) {
            ev.preventDefault();
            ev.stopPropagation();
            return;
          }
          this.selectedWidgetId.set(null);
          this.selectedDetectedPdfMedia.set(null);
          this.selectedPlacedTextId.set(null);
          this.selectedPlacedImageId.set(hit.id);
          // Body: select only (toolbar: replace / delete / drag grip). Resize uses handles; move uses HUD grip.
          if (hit.part === 'body') {
            ev.preventDefault();
            ev.stopPropagation();
            this.redrawOverlay(pageIndex);
            this.cdr.markForCheck();
            return;
          }
          (ev.currentTarget as HTMLCanvasElement | null)?.setPointerCapture?.(ev.pointerId);
          this.activePlacedImageOp = {
            pageIndex,
            id: hit.id,
            pointerId: ev.pointerId,
            mode: 'resize',
            edge: hit.part,
            startX: p.x,
            startY: p.y,
            orig: { x: anno.x, y: anno.y, w: anno.w, h: anno.h },
            historyBegun: false
          };
          ev.preventDefault();
          ev.stopPropagation();
          this.redrawOverlay(pageIndex);
          this.cdr.markForCheck();
          return;
        }

        const hitDetectedImage = this.hitTestDetectedPdfImageInteractive(pageIndex, p.x, p.y);
        console.log("hitDetectedImage  :  updateDetectedPdfImageHover ::  ", hitDetectedImage);
        if (hitDetectedImage) {
          const { media: hitMedia, part } = hitDetectedImage;
          this.selectedWidgetId.set(null);
          this.selectedDetectedPdfMedia.set(null);
          this.selectedPlacedTextId.set(null);
          const anno = this.readonlyMode()
            ? null
            : this.materializeDetectedPdfImageForEditing(pageIndex, hitMedia);
          if (anno) {
            this.selectedPlacedImageId.set(anno.id);
            if (part === 'body') {
              ev.preventDefault();
              ev.stopPropagation();
              this.redrawOverlay(pageIndex);
              this.cdr.markForCheck();
              return;
            }
            (ev.currentTarget as HTMLCanvasElement | null)?.setPointerCapture?.(ev.pointerId);
            this.activePlacedImageOp = {
              pageIndex,
              id: anno.id,
              pointerId: ev.pointerId,
              mode: 'resize',
              edge: part,
              startX: p.x,
              startY: p.y,
              orig: { x: anno.x, y: anno.y, w: anno.w, h: anno.h },
              historyBegun: false
            };
            ev.preventDefault();
            ev.stopPropagation();
            this.redrawOverlay(pageIndex);
            this.cdr.markForCheck();
            return;
          }
          this.selectedPlacedImageId.set(null);
          this.selectedDetectedPdfMedia.set({ pageIndex, media: hitMedia });
          this.focusRightbarInsertPanel();
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        this.selectedPlacedImageId.set(null);
        this.selectedPlacedTextId.set(null);
        this.imageCropSession.set(null);
        this.redrawOverlay(pageIndex);
        this.cdr.markForCheck();
      }
    }

    if (this.tool() !== 'pen') {
      const { overlay } = this.getCanvasPair(pageIndex);
      if (overlay) {
        const p = this.eventToPoint(overlay, ev);
        const hitMedia = this.hitTestDetectedMedia(pageIndex, p.x, p.y);
        if (hitMedia) {
          this.selectedWidgetId.set(null);
          this.selectedPlacedImageId.set(null);
          this.selectedPlacedTextId.set(null);
          this.selectedDetectedPdfMedia.set({ pageIndex, media: hitMedia });
          this.focusRightbarInsertPanel();
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
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

      const hitMedia = this.hitTestDetectedMedia(pageIndex, p.x, p.y);
      if (hitMedia) {
        this.selectedWidgetId.set(null);
        this.selectedPlacedImageId.set(null);
        this.selectedDetectedPdfMedia.set({ pageIndex, media: hitMedia });
        this.focusRightbarInsertPanel();
        return;
      }
      this.selectedDetectedPdfMedia.set(null);

      if (this.editExistingText()) {
        const hitReplace = this.hitTestExistingReplace(pageIndex, p.x, p.y);
        if (hitReplace) {
          this.selectedWidgetId.set(null);
          this.selectedPlacedImageId.set(null);
          this.imageCropSession.set(null);
          const { r, idx } = hitReplace;
          const bounds = this.textReplaceEditBounds(pageIndex, r);
          this.editingReplace = { pageIndex, idx };
          this.isTextPlacing.set(true);
          this.textDraft.set(r.newText);
          this.textDraftPageIndex.set(pageIndex);
          this.textDraftX.set(r.textX ?? r.x);
          this.textDraftY.set(r.textY ?? r.y);
          this.syncToolbarFromTextStyle({
            color: r.color,
            fontSize: r.fontSize,
            fontStyle: r.fontStyle,
            fontFamily: r.fontFamily ?? 'helvetica',
            bgEnabled: true,
            bgColor: r.bgColor
          });
          this.textDraftBox = {
            w: bounds.w,
            h: bounds.h,
            maskX: r.x,
            maskY: r.y,
            maskW: r.w,
            maskH: r.h,
            oldText: r.newText,
            bgColor: r.bgColor,
            color: r.color,
            maskMode: 'color',
            fontSize: r.fontSize,
            fontStyle: r.fontStyle,
            fontFamily: r.fontFamily ?? 'helvetica'
          };
          // While editing, mask the old content on the overlay so the textarea
          // sits on a clean (white) region.
          this.redrawOverlay(pageIndex);
          return;
        }
        if (this.isTextPlacing()) {
          this.cancelTextDraft();
        }
        const hit = this.hitTestDetectedBlock(pageIndex, p.x, p.y);

        if (hit) {
          if (this.isTextPlacing()) {
            this.cancelTextDraft();
          }

          this.selectedWidgetId.set(null);
          this.selectedPlacedImageId.set(null);
          this.imageCropSession.set(null);
          this.editingReplace = null;
          const sameStyleBounds = this.sameStyleTextBoundsForBlock(pageIndex, hit);
          const editBounds = {
            x: Math.min(hit.x, sameStyleBounds.x),
            y: Math.min(hit.y, sameStyleBounds.y),
            w: Math.max(hit.x + hit.w, sameStyleBounds.x + sameStyleBounds.w) - Math.min(hit.x, sameStyleBounds.x),
            h: Math.max(hit.y + hit.h, sameStyleBounds.y + sameStyleBounds.h) - Math.min(hit.y, sameStyleBounds.y)
          };
          const { fg } = this.sampleTextAndBgColors(pageIndex, editBounds);
          const bg = '#ffffff';
          // Preserve sampled background so replace/edit keeps the original look.
          this.isTextPlacing.set(true);
          this.textDraft.set(hit.text);
          this.textDraftPageIndex.set(pageIndex);
          // Pad mask bbox to fully cover anti-aliased glyph edges and descenders.
          const pad = Math.max(2, Math.ceil(hit.fontSize * 0.18));
          this.textDraftX.set(hit.x);
          this.textDraftY.set(hit.y);
          const hitFontSize = Math.round(hit.fontSize);
          this.syncToolbarFromTextStyle({
            color: fg,
            fontSize: hitFontSize,
            fontStyle: hit.fontStyle,
            fontFamily: hit.fontFamily,
            bgEnabled: true,
            bgColor: bg
          });
          const wrapWidth = this.textEditWrapWidthForPage(pageIndex, hit.x, editBounds.y, editBounds.w, editBounds.h);
          this.textDraftBox = {
            w: wrapWidth + pad * 2,
            h: editBounds.h + pad * 2,
            maskX: Math.max(0, editBounds.x - pad),
            maskY: Math.max(0, editBounds.y - pad),
            maskW: wrapWidth + pad * 2,
            maskH: editBounds.h + pad * 2,
            oldText: hit.text,
            bgColor: bg,
            color: fg,
            // Text-heavy PDF regions must erase with the sampled background color.
            // Inpainting can copy nearby words into the mask and create ghost text.
            maskMode: 'color',
            fontSize: hitFontSize,
            fontStyle: hit.fontStyle,
            fontFamily: hit.fontFamily
          };
          // While editing, mask the old content on the overlay so the textarea
          // sits on a clean (white) region.
          this.redrawOverlay(pageIndex);
          return;
        }

      }

      // Closing the inline editor via a canvas click should not immediately spawn an empty
      // draft at the same coordinates (felt like a bad duplicate / wrong "copy").
      if (closingFloatingTextDraft) return;

      // New text
      this.selectedWidgetId.set(null);
      this.selectedPlacedImageId.set(null);
      this.imageCropSession.set(null);
      this.editingReplace = null;
      this.isTextPlacing.set(true);
      this.textDraft.set('');
      this.textDraftPageIndex.set(pageIndex);
      this.textDraftX.set(p.x);
      this.textDraftY.set(p.y);
      // New text defaults to no background fill.
      this.textBgEnabled.set(false);
      this.textDraftBox = null;
      this.textDraftFreeRect.set({ w: 320, h: 44 });
      this.redrawOverlay(pageIndex);
    }
  }

  protected onOverlayPointerMove(pageIndex: number, ev: PointerEvent) {
    if (!this.activeInk) {
      this.updateDetectedPdfImageHover(pageIndex, ev);
      return;
    }
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

  protected onOverlayPointerLeave(pageIndex: number) {
    const { overlay } = this.getCanvasPair(pageIndex);
    if (overlay) overlay.style.cursor = '';
    if (this.hoveredDetectedPdfImage?.pageIndex === pageIndex) {
      this.hoveredDetectedPdfImage = null;
      this.redrawOverlay(pageIndex);
    }
  }

  private updateDetectedPdfImageHover(pageIndex: number, ev: PointerEvent) {
    if (this.tool() === 'pen') return;
    const { overlay } = this.getCanvasPair(pageIndex);
    if (!overlay) return;
    const p = this.eventToPoint(overlay, ev);
    const hitPlaced = this.hitTestPlacedImage(pageIndex, p.x, p.y);
    if (hitPlaced) {
      overlay.style.cursor = this.cursorForImagePart(hitPlaced.part);
      if (this.hoveredDetectedPdfImage?.pageIndex === pageIndex) {
        this.hoveredDetectedPdfImage = null;
        this.redrawOverlay(pageIndex);
      }
      return;
    }
    const hit = this.hitTestDetectedPdfImageInteractive(pageIndex, p.x, p.y);
    console.log("hit  :  updateDetectedPdfImageHover ::  ", hit);
    overlay.style.cursor = hit ? this.cursorForImagePart(hit.part) : '';
    const prev = this.hoveredDetectedPdfImage;
    const changed =
      prev?.pageIndex !== pageIndex ||
      prev?.media.id !== hit?.media.id ||
      prev?.part !== hit?.part;
    if (!changed) return;
    this.hoveredDetectedPdfImage = hit ? { pageIndex, media: hit.media, part: hit.part } : null;
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
    // Read the live DOM value so Enter/blur commits aren't one tick behind ngModel.
    const text = this.textDraftEditor?.nativeElement?.value ?? this.textDraft();

    // If we are editing existing text, allow empty newText (acts like delete):
    // we still create the replacement rectangle to cover the original glyphs.
    if (this.textDraftBox) {
      const styleChanged =
        this.textBgColor() !== this.textDraftBox.bgColor ||
        this.textColor() !== this.textDraftBox.color ||
        this.textSize() !== this.textDraftBox.fontSize ||
        this.textStyle() !== this.textDraftBox.fontStyle ||
        this.textFamily() !== this.textDraftBox.fontFamily;
      // If user didn't change anything, don't create a replacement (avoids flashing/white patches).
      const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (norm(text) === norm(this.textDraftBox.oldText) && !styleChanged) {
        this.isTextPlacing.set(false);
        this.textDraft.set('');
        this.textDraftPageIndex.set(null);
        this.textDraftBox = null;
        this.editingReplace = null;
        this.activeTextDraftGesture = null;
        this.textDraftFreeRect.set({ w: 320, h: 44 });
        this.redrawOverlay(pageIndex);
        return;
      }

      const anchorX = this.textDraftX();
      const anchorY = this.textDraftY();
      const wrapWidth = this.textEditWrapWidthForPage(
        pageIndex,
        anchorX,
        anchorY,
        this.textDraftBox.w,
        this.textDraftBox.h
      );
      const r: TextReplace = {
        x: this.textDraftBox.maskX,
        y: this.textDraftBox.maskY,
        w: this.textDraftBox.maskW,
        h: this.textDraftBox.maskH,
        textX: anchorX,
        textY: anchorY,
        textWrapWidth: wrapWidth,
        oldText: this.textDraftBox.oldText,
        newText: text,
        maskMode: this.textDraftBox.maskMode,
        bgColor: this.textBgColor(),
        color: this.textColor(),
        fontSize: this.textSize(),
        fontStyle: this.textStyle(),
        fontFamily: this.textFamily(),
        source: 'textEdit'
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
        id: `txt_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`,
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
    this.activeTextDraftGesture = null;
    this.textDraftFreeRect.set({ w: 320, h: 44 });
    this.redrawOverlay(pageIndex);
  }

  protected onToolbarPointerDown(ev: PointerEvent) {
    // Clicking toolbar controls blurs the textarea; we want to keep the current
    // text selection active while the user tweaks styling.
    const target = ev.target as HTMLElement | null;
    // Keep focus for click-only controls, but let native form fields receive focus/typing.
    if (target?.closest('button, label')) ev.preventDefault();
    this.captureTextDraftSelection();
    this.suppressCommitOnBlurOnce = true;
    queueMicrotask(() => {
      this.suppressCommitOnBlurOnce = false;
    });
  }

  /** Save whenever focus leaves the inline editor unless it stays inside the draft chrome. */
  protected onTextDraftFocusOut(ev: FocusEvent) {
    if (this.suppressCommitOnBlurOnce) return;
    if (this.activeTextDraftGesture) return;
    const next = (ev.relatedTarget ?? null) as HTMLElement | null;
    if (next?.closest?.('.textDraft')) return;
    this.commitTextDraft();
  }

  protected onTextDraftSelectionChange() {
    this.captureTextDraftSelection();
  }

  protected onTextDraftKeydown(ev: KeyboardEvent) {
    if (ev.key !== 'Enter') return;
    if (ev.shiftKey) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.commitTextDraft();
  }

  protected cancelTextDraft() {
    const pageIndex = this.textDraftPageIndex();
    this.isTextPlacing.set(false);
    this.textDraft.set('');
    this.textDraftPageIndex.set(null);
    this.textDraftBox = null;
    this.editingReplace = null;
    this.activeTextDraftGesture = null;
    this.textDraftFreeRect.set({ w: 320, h: 44 });
    if (pageIndex !== null) this.redrawOverlay(pageIndex);
  }

  protected deleteTextDraftFromToolbar() {
    const pageIndex = this.textDraftPageIndex();
    if (pageIndex === null) return;
    if (this.textDraftBox) {
      this.textDraft.set('');
      if (this.textDraftEditor?.nativeElement) this.textDraftEditor.nativeElement.value = '';
      this.commitTextDraft();
      return;
    }
    this.cancelTextDraft();
  }

  /** Same floating editor + toolbar as clicking the page with the Text tool (placed {@link TextAnno}, not a widget). */
  private beginNewPlacedTextAt(pageIndex: number, x: number, y: number) {
    this.editingReplace = null;
    this.selectedWidgetId.set(null);
    this.selectedDetectedPdfMedia.set(null);
    this.selectedPlacedImageId.set(null);
    this.selectedPlacedTextId.set(null);
    this.insertWidgetPending.set(null);
    this.isTextPlacing.set(true);
    this.textDraft.set('');
    this.textDraftPageIndex.set(pageIndex);
    this.textDraftX.set(x);
    this.textDraftY.set(y);
    this.textBgEnabled.set(false);
    this.textDraftBox = null;
    this.textDraftFreeRect.set({ w: 320, h: 44 });
    this.tool.set('text');
    this.redrawOverlay(pageIndex);
    queueMicrotask(() => {
      this.textDraftEditor?.nativeElement?.focus({ preventScroll: true });
      this.cdr.markForCheck();
    });
  }

  private getTextDraftLayoutSize(): { w: number; h: number } {
    const compact = this.getTextDraftVisibleFrameSize();
    if (compact) return compact;
    const box = this.textDraftBox;
    if (box) {
      return { w: Math.max(160, Math.round(box.w)), h: Math.max(44, Math.round(box.h)) };
    }
    const fr = this.textDraftFreeRect();
    return { w: Math.max(160, Math.round(fr.w)), h: Math.max(44, Math.round(fr.h)) };
  }

  private setTextDraftLayoutSize(nw: number, nh: number) {
    const w = Math.max(120, Math.round(nw));
    const h = Math.max(40, Math.round(nh));
    if (this.textDraftBox) {
      this.textDraftBox = { ...this.textDraftBox, w, h };
    } else {
      this.textDraftFreeRect.set({ w, h });
    }
  }

  private getTextDraftVisibleFrameSize(): { w: number; h: number } | null {
    if (!this.textDraftBox) return null;
    const text = this.textDraft();
    const fontSize = this.textSize();
    const measured = this.measureTextBlockCss(text, fontSize, this.textStyle(), this.textFamily());
    const pad = Math.max(12, Math.ceil(fontSize * 0.75));
    const maxW = Math.max(120, Math.min(this.textDraftBox.w, this.textDraftBox.maskW));
    const maxH = Math.max(40, this.textDraftBox.h);
    return {
      w: Math.max(120, Math.min(maxW, Math.ceil(measured.w + pad))),
      h: Math.max(40, Math.min(maxH, Math.ceil(measured.h + Math.max(8, fontSize * 0.35))))
    };
  }

  /** Outer shell: toolbar sits above the text frame; `top` is offset so the textarea stays at textDraftY. */
  protected textDraftShellStyle() {
    const pageIndex = this.textDraftPageIndex();
    if (pageIndex === null) return {};
    const toolbar = PdfEditorComponent.textDraftToolbarHeightPx;
    const gap = PdfEditorComponent.textDraftToolbarGapPx;
    const { w } = this.getTextDraftLayoutSize();
    const ty = this.textDraftY();
    const top = Math.max(0, ty - toolbar - gap);
    return {
      position: 'absolute' as const,
      left: `${this.textDraftX()}px`,
      top: `${top}px`,
      width: `${w}px`,
      zIndex: 7
    };
  }

  /** Text area frame (typography + size). */
  protected textDraftFrameStyle() {
    const pageIndex = this.textDraftPageIndex();
    if (pageIndex === null) return {};
    const { w, h } = this.getTextDraftLayoutSize();
    const fontStyle = this.textStyle();
    const style = fontStyle.includes('italic') ? 'italic' : 'normal';
    const weight = fontStyle.includes('bold') ? '700' : '400';

    return {
      width: `${w}px`,
      height: `${h}px`,
      color: this.textColor(),
      background: this.textBgEnabled() ? this.textBgColor() : 'transparent',
      fontSize: `${this.textSize()}px`,
      fontStyle: style,
      fontWeight: weight,
      fontFamily: cssFontFamily(this.textFamily()),
      lineHeight: '1.2'
    };
  }

  protected onTextDraftMovePointerDown(ev: PointerEvent) {
    if (this.readonlyMode()) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.captureTextDraftSelection();
    this.suppressCommitOnBlurOnce = true;
    queueMicrotask(() => {
      this.suppressCommitOnBlurOnce = false;
    });
    const pageIndex = this.textDraftPageIndex();
    if (pageIndex === null) return;
    const { overlay } = this.getCanvasPair(pageIndex);
    if (!overlay) return;
    const pt = this.eventToPoint(overlay, ev);
    (ev.currentTarget as HTMLElement | null)?.setPointerCapture?.(ev.pointerId);
    this.activeTextDraftGesture = {
      pageIndex,
      pointerId: ev.pointerId,
      kind: 'move',
      startX: pt.x,
      startY: pt.y,
      origX: this.textDraftX(),
      origY: this.textDraftY()
    };
  }

  protected onTextDraftResizePointerDown(edge: TextDraftResizeEdge, ev: PointerEvent) {
    if (this.readonlyMode()) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.captureTextDraftSelection();
    this.suppressCommitOnBlurOnce = true;
    queueMicrotask(() => {
      this.suppressCommitOnBlurOnce = false;
    });
    const pageIndex = this.textDraftPageIndex();
    if (pageIndex === null) return;
    const { overlay } = this.getCanvasPair(pageIndex);
    if (!overlay) return;
    const pt = this.eventToPoint(overlay, ev);
    (ev.currentTarget as HTMLElement | null)?.setPointerCapture?.(ev.pointerId);
    const { w, h } = this.getTextDraftLayoutSize();
    this.activeTextDraftGesture = {
      pageIndex,
      pointerId: ev.pointerId,
      kind: 'resize',
      edge,
      startX: pt.x,
      startY: pt.y,
      origX: this.textDraftX(),
      origY: this.textDraftY(),
      origW: w,
      origH: h
    };
  }

  protected duplicateTextDraft() {
    if (this.readonlyMode()) return;
    const pageIndex = this.textDraftPageIndex();
    if (pageIndex === null) return;
    const { overlay } = this.getCanvasPair(pageIndex);
    if (!overlay) return;
    const { w: rw, h: rh } = this.overlayNominalCssSize(overlay);
    const text = this.textDraftEditor?.nativeElement?.value ?? this.textDraft();
    const { w, h } = this.getTextDraftLayoutSize();
    const x0 = this.textDraftX();
    const y0 = this.textDraftY();
    const step = 22;
    const nx = clamp(x0 + step, 0, Math.max(0, rw - w));
    const ny = clamp(y0 + step, 0, Math.max(0, rh - h));

    this.commitTextDraft();

    this.isTextPlacing.set(true);
    this.textDraftPageIndex.set(pageIndex);
    this.textDraft.set(text);
    this.textDraftX.set(nx);
    this.textDraftY.set(ny);
    this.textDraftBox = null;
    this.editingReplace = null;
    this.textDraftFreeRect.set({ w, h });
    this.redrawOverlay(pageIndex);
    queueMicrotask(() => this.textDraftEditor?.nativeElement?.focus({ preventScroll: true }));
  }

  protected onTextDraftChromePointerDown(ev: PointerEvent) {
    this.captureTextDraftSelection();
    this.suppressCommitOnBlurOnce = true;
    queueMicrotask(() => {
      this.suppressCommitOnBlurOnce = false;
    });
  }

  private textReplaceEditBounds(pageIndex: number, r: TextReplace) {
    const pad = Math.max(2, Math.ceil(r.fontSize * 0.18));
    const textX = r.textX ?? r.x;
    const textY = r.textY ?? r.y;
    const wrapWidth = this.textEditWrapWidthForPage(pageIndex, textX, textY, r.textWrapWidth ?? r.w, r.h);
    const measured = this.measureTextBlockCss(r.newText, r.fontSize, r.fontStyle, r.fontFamily ?? 'helvetica', wrapWidth);
    const right = this.textEditRightBoundary(pageIndex, textX, textY, r.h, textX + Math.max(wrapWidth, measured.w) + pad);
    const bottom = Math.max(r.y + r.h, textY + measured.h + pad);
    return {
      x: Math.max(0, Math.min(r.x, textX) - pad),
      y: Math.max(0, Math.min(r.y, textY) - pad),
      w: Math.max(1, right - Math.max(0, Math.min(r.x, textX) - pad)),
      h: Math.max(1, bottom - Math.max(0, Math.min(r.y, textY) - pad))
    };
  }

  private textEditWrapWidthForPage(pageIndex: number, x: number, y: number, requestedWidth: number, height: number) {
    const pad = 8;
    const mediaRight = this.nearestMediaBoundaryRight(pageIndex, x, y, height);
    const requestedRight = x + Math.max(8, requestedWidth);
    const right = mediaRight ?? requestedRight;
    return Math.max(8, right - x - pad);
  }

  private sameStyleTextBoundsForBlock(pageIndex: number, block: DetectedBlock) {
    const rightLimit = this.nearestMediaBoundaryRight(pageIndex, block.x, block.y, block.h) ?? Number.POSITIVE_INFINITY;
    const yPad = Math.max(2, block.fontSize * 0.35);
    const xPad = Math.max(16, block.fontSize);
    const y0 = block.y - yPad;
    const y1 = block.y + block.h + yPad;
    const sizeTol = Math.max(1, block.fontSize * 0.12);
    let x0 = block.x;
    let yMin = block.y;
    let x1 = block.x + block.w;
    let yMax = block.y + block.h;

    for (const item of this.detectedTextByPage()[pageIndex] ?? []) {
      const sameStyle =
        item.fontStyle === block.fontStyle &&
        item.fontFamily === block.fontFamily &&
        Math.abs(item.fontSize - block.fontSize) <= sizeTol;
      if (!sameStyle) continue;
      const overlapsY = item.y + item.h >= y0 && item.y <= y1;
      if (!overlapsY) continue;
      if (item.x < block.x - xPad || item.x >= rightLimit) continue;

      x0 = Math.min(x0, item.x);
      yMin = Math.min(yMin, item.y);
      x1 = Math.max(x1, Math.min(item.x + item.w, rightLimit));
      yMax = Math.max(yMax, item.y + item.h);
    }

    return { x: x0, y: yMin, w: Math.max(1, x1 - x0), h: Math.max(1, yMax - yMin) };
  }

  private textEditRightBoundary(
    pageIndex: number,
    x: number,
    y: number,
    height: number,
    requestedRight: number
  ) {
    return Math.min(requestedRight, this.nearestMediaBoundaryRight(pageIndex, x, y, height) ?? requestedRight);
  }

  private nearestMediaBoundaryRight(pageIndex: number, x: number, y: number, height: number): number | null {
    let right: number | null = null;
    const y0 = y;
    const y1 = y + Math.max(1, height);
    for (const media of this.detectedMediaByPage()[pageIndex] ?? []) {
      const overlapsY = y1 >= media.y && y0 <= media.y + media.h;
      if (!overlapsY) continue;
      if (media.x <= x) continue;
      const candidate = Math.max(x + 8, media.x - 8);
      right = right === null ? candidate : Math.min(right, candidate);
    }
    return right;
  }

  private textReplaceCommitBounds(
    anchorX: number,
    anchorY: number,
    text: string,
    originalBox: { w: number; h: number },
    fontSize: number,
    fontStyle: FontStyle,
    fontFamily: FontFamily
  ) {
    const pad = Math.max(2, Math.ceil(fontSize * 0.18));
    const measured = this.measureTextBlockCss(text, fontSize, fontStyle, fontFamily, originalBox.w);
    return {
      x: Math.max(0, anchorX - pad),
      y: Math.max(0, anchorY - pad),
      w: Math.max(originalBox.w + pad * 2, measured.w + pad * 2),
      h: Math.max(originalBox.h + pad, measured.h + pad * 2)
    };
  }

  private measureTextBlockCss(
    text: string,
    fontSize: number,
    fontStyle: FontStyle,
    fontFamily: FontFamily,
    wrapWidth?: number
  ) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const style = fontStyle.includes('italic') ? 'italic' : 'normal';
    const weight = fontStyle.includes('bold') ? '700' : '400';
    const lh = Math.max(1, Math.round(fontSize * 1.2));
    const lines = text.split('\n');

    if (!ctx) {
      const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
      const w = Math.min(wrapWidth ?? Infinity, longest * fontSize * 0.62);
      return { w, h: Math.max(lh, lines.length * lh) };
    }

    ctx.font = `${style} ${weight} ${fontSize}px ${cssFontFamily(fontFamily)}`;
    const wrapped = wrapWidth
      ? this.wrapTextLinesByWidth(text, wrapWidth, (line) => ctx.measureText(line).width)
      : lines;
    const w = wrapped.reduce((max, line) => Math.max(max, ctx.measureText(line).width), 0);
    return { w, h: Math.max(lh, wrapped.length * lh) };
  }

  private wrapTextLinesByWidth(text: string, maxWidth: number, measure: (line: string) => number): string[] {
    const limit = Math.max(8, Number.isFinite(maxWidth) ? maxWidth : 0);
    const out: string[] = [];
    for (const paragraph of text.split('\n')) {
      if (!paragraph) {
        out.push('');
        continue;
      }

      let line = '';
      for (const word of paragraph.split(/(\s+)/)) {
        if (!word) continue;
        const next = line + word;
        if (line.trim().length > 0 && measure(next) > limit) {
          out.push(line.trimEnd());
          line = word.trimStart();
        } else {
          line = next;
        }

        while (line && measure(line) > limit) {
          let cut = line.length - 1;
          while (cut > 1 && measure(line.slice(0, cut)) > limit) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      }
      out.push(line.trimEnd());
    }
    return out.length > 0 ? out : [''];
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
    this.markEditorContentChanged();
  }

  protected readonly textWeight = computed(() => weightFromStyle(this.textStyle()));

  protected setTextWeight(weight: 400 | 700) {
    this.textStyle.set(styleWithWeight(this.textStyle(), weight));
  }

  protected setTextFamily(family: FontFamily) {
    this.applyTextToolbarChange(() => {
      this.textFamily.set(family);
      // Some PDFs expose subset font names like "ABCDEE+Helvetica-Bold".
      // Treat it as Helvetica with bold weight.
      if (family === 'abcdee_helvetica_bold') {
        this.textStyle.set(styleWithWeight(this.textStyle(), 700));
      }
    });
  }

  protected setTextSize(size: number) {
    this.applyTextToolbarChange(() => {
      this.textSize.set(size);
    });
  }

  private syncToolbarFromTextStyle(style: {
    color: string;
    fontSize: number;
    fontStyle: FontStyle;
    fontFamily: FontFamily;
    bgEnabled: boolean;
    bgColor: string;
  }) {
    const size = Math.max(1, Math.round(style.fontSize));
    this.textColor.set(style.color);
    this.textSize.set(size);
    this.textSizeInput.set(String(size));
    this.textStyle.set(style.fontStyle);
    this.textFamily.set(style.fontFamily);
    this.textBgEnabled.set(style.bgEnabled);
    this.textBgColor.set(style.bgColor);
  }

  protected setTextSizeFromInput(raw: string) {
    const parsed = Number(String(raw ?? '').trim());
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    this.setTextSize(parsed);
  }

  protected onTextSizeInputChange(raw: string) {
    this.textSizeInput.set(String(raw ?? ''));
  }

  protected commitTextSizeInput() {
    const raw = this.textSizeInput();
    const parsed = Number(String(raw ?? '').trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.textSizeInput.set(String(this.textSize()));
      return;
    }
    this.setTextSize(parsed);
  }

  protected setTextColor(color: string) {
    this.applyTextToolbarChange(() => {
      this.textColor.set(color);
    });
  }

  protected setTextBgColor(color: string) {
    this.applyTextToolbarChange(() => {
      this.textBgColor.set(color);
    });
  }

  private applyTextToolbarChange(mutator: () => void) {
    this.captureTextDraftSelection();
    mutator();
    queueMicrotask(() => this.restoreTextDraftSelection());
  }

  private captureTextDraftSelection() {
    const ta = this.textDraftEditor?.nativeElement;
    if (!ta || this.textDraftPageIndex() === null) return;
    this.textDraftSelection = {
      start: ta.selectionStart ?? 0,
      end: ta.selectionEnd ?? 0,
      direction: ta.selectionDirection ?? 'none'
    };
  }

  private restoreTextDraftSelection() {
    const ta = this.textDraftEditor?.nativeElement;
    const sel = this.textDraftSelection;
    if (!ta || !sel || this.textDraftPageIndex() === null) return;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(sel.start, sel.end, sel.direction);
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
      const replaces =
        rep.source === 'mediaErase'
          ? existing.replaces.filter((r) => !(r.source === 'mediaErase' && this.isSameReplaceRegion(r, rep)))
          : existing.replaces;
      return {
        ...prev,
        [pageIndex]: { ...existing, replaces: [...replaces, rep] }
      };
    });
    this.markEditorContentChanged();
  }

  private isSameReplaceRegion(
    a: Pick<TextReplace, 'x' | 'y' | 'w' | 'h'>,
    b: Pick<TextReplace, 'x' | 'y' | 'w' | 'h'>
  ): boolean {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.w, b.x + b.w);
    const bottom = Math.min(a.y + a.h, b.y + b.h);
    const overlapW = Math.max(0, right - left);
    const overlapH = Math.max(0, bottom - top);
    const overlapArea = overlapW * overlapH;
    if (overlapArea <= 0) return false;
    const aArea = Math.max(1, a.w * a.h);
    const bArea = Math.max(1, b.w * b.h);
    const coverage = overlapArea / Math.min(aArea, bArea);
    return coverage >= 0.7;
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
    this.markEditorContentChanged();
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
    this.markEditorContentChanged();
  }

  private newPlacedImageId(): string {
    return `img_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  }

  private getImageAnno(pageIndex: number, id: string): ImageAnno | null {
    return this.editsByPage()[pageIndex]?.images?.find((a) => a.id === id) ?? null;
  }

  private getPlacedTextAnno(pageIndex: number, id: string): TextAnno | null {
    return this.editsByPage()[pageIndex]?.text?.find((t) => t.id === id) ?? null;
  }

  private updatePlacedText(pageIndex: number, id: string, updater: (t: TextAnno) => TextAnno) {
    this.editsByPage.update((prev) => {
      const ex = prev[pageIndex];
      if (!ex) return prev;
      const text = (ex.text ?? []).map((t) => (t.id === id ? updater(t) : t));
      return { ...prev, [pageIndex]: { ...ex, text } };
    });
    this.markEditorContentChanged();
  }

  private updatePlacedImage(pageIndex: number, id: string, updater: (a: ImageAnno) => ImageAnno) {
    this.editsByPage.update((prev) => {
      const ex = prev[pageIndex];
      if (!ex) return prev;
      const images = (ex.images ?? []).map((im) => (im.id === id ? updater(im) : im));
      return { ...prev, [pageIndex]: { ...ex, images } };
    });
    this.markEditorContentChanged();
  }

  private placedImageRectDiffersFromOrig(
    op: ActivePlacedImageOp,
    next: { x: number; y: number; w: number; h: number }
  ): boolean {
    const o = op.orig;
    return next.x !== o.x || next.y !== o.y || next.w !== o.w || next.h !== o.h;
  }

  /** First time the user actually moves/resizes vs. click-to-select only, push an undo snapshot. */
  private beforeFirstPlacedImageMutation(op: ActivePlacedImageOp, next: { x: number; y: number; w: number; h: number }) {
    if (!this.placedImageRectDiffersFromOrig(op, next)) return;
    if (op.historyBegun) return;
    op.historyBegun = true;
    this.beginHistoryStep();
  }

  private getTextDraftObstacleRect(pageIndex: number): { x: number; y: number; w: number; h: number } | null {
    if (!this.isTextPlacing() || this.textDraftPageIndex() !== pageIndex) return null;
    const { w, h } = this.getTextDraftLayoutSize();
    const ty = this.textDraftY();
    const toolbar = PdfEditorComponent.textDraftToolbarHeightPx;
    const gap = PdfEditorComponent.textDraftToolbarGapPx;
    const left = this.textDraftX();
    const top = Math.max(0, ty - toolbar - gap);
    const bottom = ty + h;
    return { x: left, y: top, w, h: Math.max(h, bottom - top) };
  }

  private collectPageObstacleRects(
    pageIndex: number,
    exclude:
      | { kind: 'widget'; id: string }
      | { kind: 'placedImage'; id: string }
      | { kind: 'placedText'; id: string }
      | { kind: 'textDraft' }
      | null,
    ctx: CanvasRenderingContext2D | null
  ): Array<{ x: number; y: number; w: number; h: number }> {
    const out: Array<{ x: number; y: number; w: number; h: number }> = [];
    const page = this.editsByPage()[pageIndex];
    for (const w of this.widgetsByPage()[pageIndex] ?? []) {
      if (exclude?.kind === 'widget' && exclude.id === w.id) continue;
      if (w.w > 0 && w.h > 0) out.push({ x: w.x, y: w.y, w: w.w, h: w.h });
    }
    for (const im of page?.images ?? []) {
      if (exclude?.kind === 'placedImage' && exclude.id === im.id) continue;
      if (im.w > 0 && im.h > 0) out.push({ x: im.x, y: im.y, w: im.w, h: im.h });
    }
    for (const t of page?.text ?? []) {
      if (exclude?.kind === 'placedText' && exclude.id === t.id) continue;
      const b = ctx
        ? this.measureTextAnnoBounds(ctx, t)
        : { x: t.x, y: t.y, w: Math.max(40, t.fontSize * 2), h: Math.max(t.fontSize, 12) };
      if (b.w > 0 && b.h > 0) out.push({ x: b.x, y: b.y, w: b.w, h: b.h });
    }
    for (const r of page?.replaces ?? []) {
      if (r.w <= 0 || r.h <= 0) continue;
      // PDF embedded-image/video erase masks sit under the replacement overlay with the same
      // bbox; counting them as obstacles blocks resize (esp. south/east) because the grown rect
      // still intersects the mask.
      if (r.source === 'mediaErase') continue;
      out.push({ x: r.x, y: r.y, w: r.w, h: r.h });
    }
    if (exclude?.kind !== 'textDraft') {
      const td = this.getTextDraftObstacleRect(pageIndex);
      if (td && td.w > 0 && td.h > 0) out.push(td);
    }
    return out;
  }

  private axisRectOutOfPage(r: { x: number; y: number; w: number; h: number }, pageW: number, pageH: number): boolean {
    const eps = 1e-3;
    return r.x < -eps || r.y < -eps || r.x + r.w > pageW + eps || r.y + r.h > pageH + eps;
  }

  private constrainAxisMoveNoOverlap(
    pageW: number,
    pageH: number,
    boxW: number,
    boxH: number,
    origX: number,
    origY: number,
    intendedX: number,
    intendedY: number,
    obstacles: Array<{ x: number; y: number; w: number; h: number }>
  ): { x: number; y: number } {
    const ix = clamp(intendedX, 0, Math.max(0, pageW - boxW));
    const iy = clamp(intendedY, 0, Math.max(0, pageH - boxH));
    const hits = (x: number, y: number) => {
      const r = { x, y, w: boxW, h: boxH };
      if (this.axisRectOutOfPage(r, pageW, pageH)) return true;
      return obstacles.some((o) => axisRectsOverlap(r, o));
    };
    if (!hits(ix, iy)) return { x: ix, y: iy };
    if (hits(origX, origY)) {
      return {
        x: clamp(origX, 0, Math.max(0, pageW - boxW)),
        y: clamp(origY, 0, Math.max(0, pageH - boxH))
      };
    }
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const t = (lo + hi) / 2;
      const x = clamp(origX + t * (ix - origX), 0, Math.max(0, pageW - boxW));
      const y = clamp(origY + t * (iy - origY), 0, Math.max(0, pageH - boxH));
      if (hits(x, y)) hi = t;
      else lo = t;
    }
    const t = lo;
    return {
      x: clamp(origX + t * (ix - origX), 0, Math.max(0, pageW - boxW)),
      y: clamp(origY + t * (iy - origY), 0, Math.max(0, pageH - boxH))
    };
  }

  private constrainAxisRectLerpNoOverlap(
    pageW: number,
    pageH: number,
    orig: { x: number; y: number; w: number; h: number },
    cand: { x: number; y: number; w: number; h: number },
    minW: number,
    minH: number,
    obstacles: Array<{ x: number; y: number; w: number; h: number }>
  ): { x: number; y: number; w: number; h: number } {
    const lerp = (t: number) => ({
      x: orig.x + t * (cand.x - orig.x),
      y: orig.y + t * (cand.y - orig.y),
      w: Math.max(minW, orig.w + t * (cand.w - orig.w)),
      h: Math.max(minH, orig.h + t * (cand.h - orig.h))
    });
    const bad = (t: number) => {
      const r = lerp(t);
      if (this.axisRectOutOfPage(r, pageW, pageH)) return true;
      return obstacles.some((o) => axisRectsOverlap(r, o));
    };
    if (!bad(1)) return lerp(1);
    if (bad(0)) return lerp(0);
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (bad(mid)) hi = mid;
      else lo = mid;
    }
    return lerp(lo);
  }

  private applyPlacedTextCandidateWithNoOverlap(
    pageIndex: number,
    id: string,
    start: TextAnno,
    candidate: TextAnno,
    ctx: CanvasRenderingContext2D | null
  ): TextAnno {
    if (!ctx) return candidate;
    const obstacles = this.collectPageObstacleRects(pageIndex, { kind: 'placedText', id }, ctx);
    const boundsOf = (t: TextAnno) => this.measureTextAnnoBounds(ctx, t);
    const overlaps = (t: TextAnno) => {
      const b = boundsOf(t);
      return obstacles.some((o) => axisRectsOverlap(b, o));
    };
    if (!overlaps(candidate)) return candidate;
    if (overlaps(start)) return start;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 20; i++) {
      const tt = (lo + hi) / 2;
      const fs = Math.round(start.fontSize + tt * (candidate.fontSize - start.fontSize));
      const nx = start.x + tt * (candidate.x - start.x);
      const ny = start.y + tt * (candidate.y - start.y);
      const blended: TextAnno = { ...candidate, fontSize: fs, x: nx, y: ny };
      if (overlaps(blended)) hi = tt;
      else lo = tt;
    }
    const tt = lo;
    return {
      ...candidate,
      fontSize: Math.round(start.fontSize + tt * (candidate.fontSize - start.fontSize)),
      x: start.x + tt * (candidate.x - start.x),
      y: start.y + tt * (candidate.y - start.y)
    };
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

  private ensureTextAnnosHaveIds(pageIndex: number) {
    this.editsByPage.update((prev) => {
      const e = prev[pageIndex];
      if (!e?.text?.length || !e.text.some((t) => !t.id)) return prev;
      return {
        ...prev,
        [pageIndex]: {
          ...e,
          text: e.text.map((t, i) =>
            t.id ? t : { ...t, id: `txt_${pageIndex}_${i}_${Math.random().toString(16).slice(2, 10)}` }
          )
        }
      };
    });
  }

  private measureTextAnnoBounds(
    ctx: CanvasRenderingContext2D,
    t: TextAnno
  ): { x: number; y: number; w: number; h: number } {
    const style = t.fontStyle.includes('italic') ? 'italic' : 'normal';
    const weight = t.fontStyle.includes('bold') ? '700' : '400';
    ctx.textBaseline = 'top';
    ctx.font = `${style} ${weight} ${t.fontSize}px ${cssFontFamily(t.fontFamily ?? 'helvetica')}`;
    const lines = t.text.split('\n');
    const lh = Math.max(1, Math.round(t.fontSize * 1.2));
    let maxW = 0;
    for (const line of lines) {
      maxW = Math.max(maxW, ctx.measureText(line).width);
    }
    return { x: t.x, y: t.y, w: maxW, h: Math.max(lh, lines.length * lh) };
  }

  private placedTextCloseScreenRect(bounds: { x: number; y: number; w: number; h: number }) {
    const cw = PdfEditorComponent.placedTextClosePx;
    const pad = 6;
    const cx = bounds.x + Math.max(0, bounds.w - cw - pad);
    const cy = bounds.y + pad;
    return { x: cx, y: cy, w: cw, h: cw };
  }

  private hitTestPlacedText(
    pageIndex: number,
    x: number,
    y: number
  ): { id: string; part: 'close' | 'body' | PlacedImageEdge } | null {
    this.ensureTextAnnosHaveIds(pageIndex);
    const edit = this.editsByPage()[pageIndex];
    const list = edit?.text ?? [];
    if (list.length === 0) return null;
    const { overlay } = this.getCanvasPair(pageIndex);
    if (!overlay) return null;
    const ctx = overlay.getContext('2d');
    if (!ctx) return null;
    const pad = PdfEditorComponent.placedTextCloseHitPad;
    const hsz = PdfEditorComponent.placedImageHandleHit;
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i]!;
      const b = this.measureTextAnnoBounds(ctx, t);
      const cr = this.placedTextCloseScreenRect(b);
      if (
        x >= cr.x - pad &&
        x <= cr.x + cr.w + pad &&
        y >= cr.y - pad &&
        y <= cr.y + cr.h + pad
      ) {
        return { id: t.id, part: 'close' };
      }
      if (Math.hypot(x - b.x, y - b.y) <= hsz) return { id: t.id, part: 'nw' };
      if (Math.hypot(x - (b.x + b.w), y - b.y) <= hsz) return { id: t.id, part: 'ne' };
      if (Math.hypot(x - b.x, y - (b.y + b.h)) <= hsz) return { id: t.id, part: 'sw' };
      if (Math.hypot(x - (b.x + b.w), y - (b.y + b.h)) <= hsz) return { id: t.id, part: 'se' };
      if (Math.hypot(x - (b.x + b.w / 2), y - b.y) <= hsz) return { id: t.id, part: 'n' };
      if (Math.hypot(x - (b.x + b.w / 2), y - (b.y + b.h)) <= hsz) return { id: t.id, part: 's' };
      if (Math.hypot(x - (b.x + b.w), y - (b.y + b.h / 2)) <= hsz) return { id: t.id, part: 'e' };
      if (Math.hypot(x - b.x, y - (b.y + b.h / 2)) <= hsz) return { id: t.id, part: 'w' };
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        return { id: t.id, part: 'body' };
      }
    }
    return null;
  }

  private drawPlacedTextChrome(ctx: CanvasRenderingContext2D, t: TextAnno) {
    if (this.selectedPlacedTextId() !== t.id) return;
    const b = this.measureTextAnnoBounds(ctx, t);
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.18)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
    const cr = this.placedTextCloseScreenRect(b);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const rr = ctx as CanvasRenderingContext2D & { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void };
    if (typeof rr.roundRect === 'function') {
      rr.roundRect(cr.x, cr.y, cr.w, cr.h, 8);
    } else {
      ctx.rect(cr.x, cr.y, cr.w, cr.h);
    }
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
    ctx.font = '900 13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✕', cr.x + cr.w / 2, cr.y + cr.h / 2 + 0.5);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';

    const hs = PdfEditorComponent.placedImageHandlePx;
    const hr = hs / 2 + 0.5;
    const { x, y, w, h: hh } = b;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.22)';
    const drawCorner = (ax: number, ay: number) => {
      ctx.beginPath();
      ctx.arc(ax, ay, hr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };
    const drawEdge = (ax: number, ay: number) => {
      ctx.beginPath();
      ctx.rect(ax - hs / 2, ay - hs / 2, hs, hs);
      ctx.fill();
      ctx.stroke();
    };
    drawCorner(x, y);
    drawCorner(x + w, y);
    drawCorner(x, y + hh);
    drawCorner(x + w, y + hh);
    drawEdge(x + w / 2, y);
    drawEdge(x + w / 2, y + hh);
    drawEdge(x + w, y + hh / 2);
    drawEdge(x, y + hh / 2);
  }

  private removePlacedTextAnno(pageIndex: number, id: string) {
    this.beginHistoryStep('Remove text box');
    if (this.activePlacedTextOp?.pageIndex === pageIndex && this.activePlacedTextOp.id === id) {
      this.activePlacedTextOp = null;
    }
    this.editsByPage.update((prev) => {
      const ex = prev[pageIndex];
      if (!ex) return prev;
      return {
        ...prev,
        [pageIndex]: { ...ex, text: (ex.text ?? []).filter((anno) => anno.id !== id) }
      };
    });
    if (this.selectedPlacedTextId() === id) this.selectedPlacedTextId.set(null);
    this.redrawOverlay(pageIndex);
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
      if (Math.hypot(x - ix, y - iy) <= hsz) return { id: im.id, part: 'nw' };
      if (Math.hypot(x - (ix + iw), y - iy) <= hsz) return { id: im.id, part: 'ne' };
      if (Math.hypot(x - ix, y - (iy + ih)) <= hsz) return { id: im.id, part: 'sw' };
      if (Math.hypot(x - (ix + iw), y - (iy + ih)) <= hsz) return { id: im.id, part: 'se' };
      if (Math.hypot(x - (ix + iw / 2), y - iy) <= hsz) return { id: im.id, part: 'n' };
      if (Math.hypot(x - (ix + iw / 2), y - (iy + ih)) <= hsz) return { id: im.id, part: 's' };
      if (Math.hypot(x - (ix + iw), y - (iy + ih / 2)) <= hsz) return { id: im.id, part: 'e' };
      if (Math.hypot(x - ix, y - (iy + ih / 2)) <= hsz) return { id: im.id, part: 'w' };
      if (x >= ix && x <= ix + iw && y >= iy && y <= iy + ih) return { id: im.id, part: 'body' };
    }
    return null;
  }

  private hitTestImageRectPart(
    rect: { x: number; y: number; w: number; h: number },
    x: number,
    y: number
  ): 'body' | PlacedImageEdge | null {
    const hsz = PdfEditorComponent.placedImageHandleHit;
    const { x: ix, y: iy, w: iw, h: ih } = rect;
    if (Math.hypot(x - ix, y - iy) <= hsz) return 'nw';
    if (Math.hypot(x - (ix + iw), y - iy) <= hsz) return 'ne';
    if (Math.hypot(x - ix, y - (iy + ih)) <= hsz) return 'sw';
    if (Math.hypot(x - (ix + iw), y - (iy + ih)) <= hsz) return 'se';
    if (Math.hypot(x - (ix + iw / 2), y - iy) <= hsz) return 'n';
    if (Math.hypot(x - (ix + iw / 2), y - (iy + ih)) <= hsz) return 's';
    if (Math.hypot(x - (ix + iw), y - (iy + ih / 2)) <= hsz) return 'e';
    if (Math.hypot(x - ix, y - (iy + ih / 2)) <= hsz) return 'w';
    if (x >= ix && x <= ix + iw && y >= iy && y <= iy + ih) return 'body';
    return null;
  }

  private hitTestDetectedPdfImageInteractive(
    pageIndex: number,
    x: number,
    y: number
  ): { media: DetectedPdfMedia; part: 'body' | PlacedImageEdge } | null {
    const items = this.detectedMediaByPage()[pageIndex] ?? [];
    let best: { media: DetectedPdfMedia; part: 'body' | PlacedImageEdge } | null = null;
    let bestArea = Infinity;
    for (const media of items) {
      if (media.kind !== 'image') continue;
      const part = this.hitTestImageRectPart(media, x, y);
      if (!part) continue;
      const area = Math.max(1, media.w) * Math.max(1, media.h);
      if (area < bestArea) {
        bestArea = area;
        best = { media, part };
      }
    }
    return best;
  }

  private cursorForImagePart(part: 'body' | PlacedImageEdge): string {
    switch (part) {
      case 'n':
      case 's':
        return 'ns-resize';
      case 'e':
      case 'w':
        return 'ew-resize';
      case 'ne':
      case 'sw':
        return 'nesw-resize';
      case 'nw':
      case 'se':
        return 'nwse-resize';
      default:
        return 'pointer';
    }
  }

  private drawImageRectChrome(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; w: number; h: number }) {
    const hs = PdfEditorComponent.placedImageHandlePx;
    const hr = hs / 2 + 0.5;
    const { x, y, w, h: hh } = rect;
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.32)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x, y, w, hh);
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(100, 116, 139, 0.55)';

    const drawDot = (ax: number, ay: number) => {
      ctx.beginPath();
      ctx.arc(ax, ay, hr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };
    drawDot(x, y);
    drawDot(x + w / 2, y);
    drawDot(x + w, y);
    drawDot(x + w, y + hh / 2);
    drawDot(x + w, y + hh);
    drawDot(x + w / 2, y + hh);
    drawDot(x, y + hh);
    drawDot(x, y + hh / 2);
  }

  private drawPlacedImageChrome(ctx: CanvasRenderingContext2D, anno: ImageAnno) {
    if (this.selectedPlacedImageId() !== anno.id) return;
    this.drawImageRectChrome(ctx, anno);
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
    // Clear in untransformed device pixels so dashed selection strokes / handles never leave fringe pixels.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = overlay.width / dpr;
    const h = overlay.height / dpr;

    // If we're editing existing text, temporarily cover the old region on the overlay.
    // Match the selected background so preview and commit are visually consistent.
    if (this.isTextPlacing() && this.textDraftPageIndex() === pageIndex && this.textDraftBox) {
      ctx.fillStyle = this.textBgColor();
      ctx.fillRect(this.textDraftBox.maskX, this.textDraftBox.maskY, this.textDraftBox.maskW, this.textDraftBox.maskH);
      ctx.fillRect(this.textDraftX(), this.textDraftY(), this.textDraftBox.w, this.textDraftBox.h);
    }

    const edit = this.editsByPage()[pageIndex];
    if (!edit) {
      const hoveredImage = this.hoveredDetectedPdfImage;
      if (hoveredImage?.pageIndex === pageIndex) {
        this.drawImageRectChrome(ctx, hoveredImage.media);
      }
      return;
    }

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
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i] ?? '', t.x, t.y + i * lh);
      }
    }

    for (const t of edit.text) {
      this.drawPlacedTextChrome(ctx, t);
    }

    for (const img of edit.images) {
      this.drawPlacedImageChrome(ctx, img);
    }

    const hoveredImage = this.hoveredDetectedPdfImage;
    if (hoveredImage?.pageIndex === pageIndex) {
      this.drawImageRectChrome(ctx, hoveredImage.media);
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
      if (r.maskMode === 'inpaint' && r.source !== 'textEdit') {
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
        const lines = this.wrapTextLinesByWidth(r.newText, r.textWrapWidth ?? r.w, (line) => ctx.measureText(line).width);
        const lh = Math.max(1, Math.round(r.fontSize * 1.2));
        const textX = r.textX ?? r.x;
        const textY = r.textY ?? r.y;
        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], textX, textY + i * lh);
        }
      }
    }
  }

  /**
   * Map pointer position to PDF.js viewport CSS coordinates (same space as {@link getCssViewportForPdfPage}).
   * Normalizes against the element's laid-out size so browser zoom / subpixel drift does not skew hits vs drawing.
   */
  private eventToPoint(canvas: HTMLCanvasElement, ev: { clientX: number; clientY: number }): InkPoint {
    const dpr = window.devicePixelRatio || 1;
    const nominalW = canvas.width / dpr;
    const nominalH = canvas.height / dpr;
    const rect = canvas.getBoundingClientRect();
    const rw = rect.width > 0 ? rect.width : nominalW;
    const rh = rect.height > 0 ? rect.height : nominalH;
    const x = ((ev.clientX - rect.left) / rw) * nominalW;
    const y = ((ev.clientY - rect.top) / rh) * nominalH;
    return { x: clamp(x, 0, nominalW), y: clamp(y, 0, nominalH) };
  }

  private pdfCornersToViewportAabb(
    cssViewport: { convertToViewportPoint: (x: number, y: number) => number[] },
    cornersPdf: [number, number][]
  ): { x: number; y: number; w: number; h: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [px, py] of cornersPdf) {
      const [vx, vy] = cssViewport.convertToViewportPoint(px, py);
      minX = Math.min(minX, vx);
      maxX = Math.max(maxX, vx);
      minY = Math.min(minY, vy);
      maxY = Math.max(maxY, vy);
    }
    return {
      x: minX,
      y: minY,
      w: Math.max(1, maxX - minX),
      h: Math.max(1, maxY - minY)
    };
  }

  private collectImageRectsFromOperatorList(
    opList: { fnArray: number[]; argsArray: any[] },
    cssViewport: { convertToViewportPoint: (x: number, y: number) => number[] }
  ): Array<{ x: number; y: number; w: number; h: number }> {
    const out: Array<{ x: number; y: number; w: number; h: number }> = [];
    const stack: number[][] = [[1, 0, 0, 1, 0, 0]];
    const ctm = () => stack[stack.length - 1]!;

    const unitSquareToViewport = (m: number[]) => {
      const corners: [number, number][] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1]
      ];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [ux, uy] of corners) {
        const p: number[] = [ux, uy];
        Util.applyTransform(p, m, 0);
        const [vx, vy] = cssViewport.convertToViewportPoint(p[0]!, p[1]!);
        minX = Math.min(minX, vx);
        maxX = Math.max(maxX, vx);
        minY = Math.min(minY, vy);
        maxY = Math.max(maxY, vy);
      }
      out.push({
        x: minX,
        y: minY,
        w: Math.max(1, maxX - minX),
        h: Math.max(1, maxY - minY)
      });
    };

    const { fnArray, argsArray } = opList;
    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i]!;
      const args = argsArray[i] ?? [];
      switch (fn) {
        case OPS.save:
          stack.push([...ctm()]);
          break;
        case OPS.restore:
          if (stack.length > 1) stack.pop();
          break;
        case OPS.transform: {
          const t = args as number[];
          if (t.length >= 6) {
            stack[stack.length - 1] = Util.transform(ctm(), [
              t[0]!,
              t[1]!,
              t[2]!,
              t[3]!,
              t[4]!,
              t[5]!
            ]);
          }
          break;
        }
        case OPS.paintImageXObject:
          unitSquareToViewport(ctm());
          break;
        case OPS.paintInlineImageXObject: {
          const img = args[0];
          const iw = Number(img?.width ?? 0);
          const ih = Number(img?.height ?? 0);
          if (iw > 0 && ih > 0) unitSquareToViewport(ctm());
          break;
        }
        case OPS.paintImageXObjectRepeat: {
          const scaleX = Number(args[1] ?? 1);
          const scaleY = Number(args[2] ?? 1);
          const positions = args[3] as number[] | undefined;
          if (positions && positions.length >= 2) {
            for (let k = 0; k < positions.length; k += 2) {
              const local = [scaleX, 0, 0, scaleY, positions[k]!, positions[k + 1]!];
              unitSquareToViewport(Util.transform(ctm(), local));
            }
          }
          break;
        }
        case OPS.paintInlineImageXObjectGroup: {
          const map = args[1] as Array<{ transform: number[] }> | undefined;
          if (map) {
            for (const entry of map) {
              const tr = entry.transform;
              if (Array.isArray(tr) && tr.length >= 6) {
                unitSquareToViewport(Util.transform(ctm(), tr));
              }
            }
          }
          break;
        }
        case OPS.paintImageMaskXObjectGroup: {
          const images = args[0] as Array<{ transform: number[] }> | undefined;
          if (images) {
            for (const image of images) {
              const tr = image.transform;
              if (Array.isArray(tr) && tr.length >= 6) {
                unitSquareToViewport(Util.transform(ctm(), tr));
              }
            }
          }
          break;
        }
        case OPS.paintImageMaskXObjectRepeat: {
          const scaleX = Number(args[1] ?? 1);
          const skewX = Number(args[2] ?? 0);
          const skewY = Number(args[3] ?? 0);
          const scaleY = Number(args[4] ?? 1);
          const positions = args[5] as number[] | undefined;
          if (positions && positions.length >= 2) {
            for (let k = 0; k < positions.length; k += 2) {
              const local = [scaleX, skewX, skewY, scaleY, positions[k]!, positions[k + 1]!];
              unitSquareToViewport(Util.transform(ctm(), local));
            }
          }
          break;
        }
        case OPS.paintImageMaskXObject:
        case OPS.paintSolidColorImageMask:
          unitSquareToViewport(ctm());
          break;
        default:
          break;
      }
    }
    return out;
  }

  private async collectVideoRectsFromAnnotations(
    page: { getAnnotations: () => Promise<any[]> },
    cssViewport: { convertToViewportPoint: (x: number, y: number) => number[] }
  ): Promise<Array<{ x: number; y: number; w: number; h: number }>> {
    const out: Array<{ x: number; y: number; w: number; h: number }> = [];
    let annotations: any[] = [];
    try {
      annotations = await page.getAnnotations();
    } catch {
      return out;
    }
    for (const a of annotations) {
      const t = Number(a.annotationType ?? 0);
      if (t !== AnnotationType.MOVIE && t !== AnnotationType.SCREEN) continue;
      const rect = a.rect;
      if (!Array.isArray(rect) || rect.length < 4) continue;
      const x1 = Number(rect[0]);
      const y1 = Number(rect[1]);
      const x2 = Number(rect[2]);
      const y2 = Number(rect[3]);
      const box = this.pdfCornersToViewportAabb(cssViewport, [
        [x1, y1],
        [x2, y1],
        [x2, y2],
        [x1, y2]
      ]);
      if (box.w < 2 || box.h < 2) continue;
      out.push(box);
    }
    return out;
  }

  private async detectPdfMediaForPage(pageIndex: number, page: any, cssViewport: any) {
    console.log("deletcte on page", pageIndex);
    
    let imageRects: Array<{ x: number; y: number; w: number; h: number }> = [];
    try {
      const opList = await page.getOperatorList();
      imageRects = this.collectImageRectsFromOperatorList(opList, cssViewport);
    } catch {
      // Keep video/media annotation detection alive even if image operator extraction fails.
      imageRects = [];
    }
    const videoRects = await this.collectVideoRectsFromAnnotations(page, cssViewport);
    const items: DetectedPdfMedia[] = [];
    const dedupe = new Map<string, number>();
    const stableId = (kind: 'image' | 'video', r: { x: number; y: number; w: number; h: number }) => {
      const rx = Math.round(r.x);
      const ry = Math.round(r.y);
      const rw = Math.round(r.w);
      const rh = Math.round(r.h);
      const base = `pdfmedia_p${pageIndex}_${kind}_${rx}_${ry}_${rw}_${rh}`;
      const seen = dedupe.get(base) ?? 0;
      dedupe.set(base, seen + 1);
      return seen === 0 ? base : `${base}_${seen}`;
    };
    for (const r of imageRects) {
      if (r.w < 3 || r.h < 3) continue;
      // Skip page-covering rasters (backgrounds / flattened pages); only surface real inset images.
      if (this.isWholePageLikeMediaRect(r, cssViewport)) continue;
      items.push({
        id: stableId('image', r),
        kind: 'image',
        ...r
      });
    }
    for (const r of videoRects) {
      items.push({
        id: stableId('video', r),
        kind: 'video',
        ...r
      });
    }
    this.detectedMediaByPage.update((prev) => ({ ...prev, [pageIndex]: items }));
  }

  /**
   * Skip near–full-bleed rasters (flattened page / background). Uses strict coverage only —
   * the old “large centered” heuristic matched normal inset photos and hid all real images.
   */
  private isWholePageLikeMediaRect(
    rect: { x: number; y: number; w: number; h: number },
    cssViewport: { width: number; height: number }
  ): boolean {
    const pageW = Math.max(1, Number(cssViewport?.width ?? 0));
    const pageH = Math.max(1, Number(cssViewport?.height ?? 0));
    const wRatio = rect.w / pageW;
    const hRatio = rect.h / pageH;
    const areaRatio = (rect.w * rect.h) / (pageW * pageH);
    const nearFullAxes = wRatio >= 0.985 && hRatio >= 0.985;
    const nearFullArea = areaRatio >= 0.97;
    return nearFullAxes || nearFullArea;
  }

  private dropDetectedMediaEntry(pageIndex: number, id: string) {
    this.detectedMediaByPage.update((prev) => ({
      ...prev,
      [pageIndex]: (prev[pageIndex] ?? []).filter((x) => x.id !== id)
    }));
  }

  private eraseDetectedPdfMedia(pageIndex: number, m: DetectedPdfMedia) {
    // "Remove detected image/video" should affect only the selected media area:
    // fill that full area with white, leave everything else untouched.
    // Also drop any user replacement overlay tied to this detection, or dashed handles / image chrome stay behind.
    const replacementAnno = this.findReplacementImageAnnoForDetected(pageIndex, m);
    const linkKey = this.detectedMediaLinkKey(pageIndex, m.id);
    const mappedId = this.embeddedImageReplacementByDetectedId.get(linkKey);
    this.embeddedImageReplacementByDetectedId.delete(linkKey);
    const replaceId = replacementAnno?.id ?? mappedId ?? null;

    if (replaceId) {
      if (this.selectedPlacedImageId() === replaceId) this.selectedPlacedImageId.set(null);
      if (this.activePlacedImageOp?.pageIndex === pageIndex && this.activePlacedImageOp.id === replaceId) {
        this.activePlacedImageOp = null;
      }
      const c = this.imageCropSession();
      if (c?.mode === 'placed' && c.pageIndex === pageIndex && c.id === replaceId) {
        this.imageCropSession.set(null);
      }
    }

    const inset = 0;
    const rw = Math.max(1, m.w - inset * 2);
    const rh = Math.max(1, m.h - inset * 2);
    const rx = m.x + (m.w - rw) / 2;
    const ry = m.y + (m.h - rh) / 2;
    const rep: TextReplace = {
      x: rx,
      y: ry,
      w: rw,
      h: rh,
      oldText: '',
      newText: '',
      maskMode: 'color',
      bgColor: '#ffffff',
      color: '#000000',
      fontSize: 12,
      fontStyle: 'regular',
      fontFamily: 'helvetica',
      source: 'mediaErase'
    };

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
      let images = existing.images ?? [];
      if (replaceId) images = images.filter((im) => im.id !== replaceId);
      const replaces =
        rep.source === 'mediaErase'
          ? existing.replaces.filter((r) => !(r.source === 'mediaErase' && this.isSameReplaceRegion(r, rep)))
          : existing.replaces;
      return {
        ...prev,
        [pageIndex]: { ...existing, images, replaces: [...replaces, rep] }
      };
    });

    this.dropDetectedMediaEntry(pageIndex, m.id);
    const selected = this.selectedDetectedPdfMedia();
    if (selected && selected.pageIndex === pageIndex && selected.media.id === m.id) {
      this.selectedDetectedPdfMedia.set(null);
    }
    this.applyReplacesToBase(pageIndex);
    this.redrawOverlay(pageIndex);
  }

  private mediaEraseReplaceForBox(box: { x: number; y: number; w: number; h: number }): TextReplace {
    return {
      x: box.x,
      y: box.y,
      w: Math.max(1, box.w),
      h: Math.max(1, box.h),
      oldText: '',
      newText: '',
      maskMode: 'color',
      bgColor: '#ffffff',
      color: '#000000',
      fontSize: 12,
      fontStyle: 'regular',
      fontFamily: 'helvetica',
      source: 'mediaErase'
    };
  }

  private captureBaseCanvasRectAsImage(
    pageIndex: number,
    box: { x: number; y: number; w: number; h: number }
  ): { dataUrl: string; srcW: number; srcH: number } | null {
    const { base } = this.getCanvasPair(pageIndex);
    if (!base) return null;
    const cssW = parseFloat(base.style.width) || base.width;
    const cssH = parseFloat(base.style.height) || base.height;
    const sx = base.width / Math.max(1, cssW);
    const sy = base.height / Math.max(1, cssH);
    const srcX = clamp(Math.floor(box.x * sx), 0, Math.max(0, base.width - 1));
    const srcY = clamp(Math.floor(box.y * sy), 0, Math.max(0, base.height - 1));
    const srcW = clamp(Math.ceil(box.w * sx), 1, Math.max(1, base.width - srcX));
    const srcH = clamp(Math.ceil(box.h * sy), 1, Math.max(1, base.height - srcY));
    const tmp = document.createElement('canvas');
    tmp.width = srcW;
    tmp.height = srcH;
    const ctx = tmp.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(base, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);
    return { dataUrl: tmp.toDataURL('image/png'), srcW, srcH };
  }

  private materializeDetectedPdfImageForEditing(pageIndex: number, media: DetectedPdfMedia): ImageAnno | null {
    if (media.kind !== 'image') return null;
    const existing = this.findReplacementImageAnnoForDetected(pageIndex, media);
    if (existing) return existing;
    const captured = this.captureBaseCanvasRectAsImage(pageIndex, media);
    if (!captured) return null;
    const id = this.replacementImageIdForBox(pageIndex, media);
    const anno: ImageAnno = {
      id,
      x: media.x,
      y: media.y,
      w: Math.max(1, media.w),
      h: Math.max(1, media.h),
      dataUrl: captured.dataUrl,
      srcW: captured.srcW,
      srcH: captured.srcH
    };
    const erase = this.mediaEraseReplaceForBox(media);

    this.beginHistoryStep();
    this.editsByPage.update((prev) => {
      const existingPage = prev[pageIndex] ?? {
        viewportWidth: 1,
        viewportHeight: 1,
        ink: [],
        text: [],
        images: [],
        replaces: []
      };
      const vp = this.mergePageEditViewport(pageIndex, existingPage);
      const images = [...(existingPage.images ?? []).filter((im) => im.id !== id), anno];
      const replaces = [
        ...(existingPage.replaces ?? []).filter((r) => !(r.source === 'mediaErase' && this.isSameReplaceRegion(r, erase))),
        erase
      ];
      return {
        ...prev,
        [pageIndex]: { ...existingPage, ...vp, images, replaces }
      };
    });

    this.embeddedImageReplacementByDetectedId.set(this.detectedMediaLinkKey(pageIndex, media.id), id);
    this.dropDetectedMediaEntry(pageIndex, media.id);
    this.applyReplacesToBase(pageIndex);
    this.redrawOverlay(pageIndex);
    this.markEditorContentChanged();
    return anno;
  }

  private beginEmbeddedMediaReplace(pageIndex: number, m: DetectedPdfMedia) {
    this.embeddedMediaReplaceTarget = {
      pageIndex,
      id: m.id,
      kind: m.kind,
      x: m.x,
      y: m.y,
      w: m.w,
      h: m.h
    };
    if (m.kind === 'image') {
      const el = this.widgetImageFile?.nativeElement;
      if (el) {
        el.value = '';
        el.click();
      }
      return;
    }
    const el = this.widgetVideoFile?.nativeElement;
    if (el) {
      el.value = '';
      el.click();
    }
  }

  private async placeReplacementImageInPdfMediaRect(pageIndex: number, dataUrl: string, box: DetectedPdfMedia) {
    const img = await this.loadHtmlImage(dataUrl);
    const natW = Math.max(1, img.naturalWidth);
    const natH = Math.max(1, img.naturalHeight);
    const target = { x: box.x, y: box.y, w: Math.max(1, box.w), h: Math.max(1, box.h) };
    // Fully cover the detected target region so old background is completely hidden.
    // (Use center-crop from source image when aspect ratios differ.)
    const scale = Math.max(target.w / natW, target.h / natH);
    const srcW = Math.max(1, target.w / scale);
    const srcH = Math.max(1, target.h / scale);
    const cropX = Math.max(0, (natW - srcW) / 2);
    const cropY = Math.max(0, (natH - srcH) / 2);
    const x = target.x;
    const y = target.y;
    const w = target.w;
    const h = target.h;
    // Use geometry-based stable id so replace stays bound to the same area
    // even when detected-media runtime ids change after rerender/zoom.
    const id = this.replacementImageIdForBox(pageIndex, box);
    const anno: ImageAnno = {
      id,
      x,
      y,
      w,
      h,
      dataUrl,
      srcW: natW,
      srcH: natH,
      crop: { x: cropX, y: cropY, w: srcW, h: srcH }
    };
    const erase = this.mediaEraseReplaceForBox(box);

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
      const vp = this.mergePageEditViewport(pageIndex, existing);
      const images = [...(existing.images ?? []).filter((im) => im.id !== id), anno];
      const replaces = [
        ...(existing.replaces ?? []).filter((r) => !(r.source === 'mediaErase' && this.isSameReplaceRegion(r, erase))),
        erase
      ];
      return {
        ...prev,
        [pageIndex]: { ...existing, ...vp, images, replaces }
      };
    });
    this.embeddedImageReplacementByDetectedId.set(this.detectedMediaLinkKey(pageIndex, box.id), id);
    this.dropDetectedMediaEntry(pageIndex, box.id);
    const selected = this.selectedDetectedPdfMedia();
    if (selected && selected.pageIndex === pageIndex && selected.media.id === box.id) {
      this.selectedDetectedPdfMedia.set(null);
    }
    this.selectedPlacedImageId.set(id);
    this.applyReplacesToBase(pageIndex);
    this.redrawOverlay(pageIndex);
    this.markEditorContentChanged();
  }

  private replacementImageIdForBox(pageIndex: number, box: { x: number; y: number; w: number; h: number }): string {
    const rx = Math.round(box.x);
    const ry = Math.round(box.y);
    const rw = Math.round(box.w);
    const rh = Math.round(box.h);
    return `pdfmedia_replace_p${pageIndex}_${rx}_${ry}_${rw}_${rh}`;
  }

  private getCappedReplaceRect(box: { x: number; y: number; w: number; h: number }) {
    const w = Math.max(1, Math.min(400, box.w));
    const h = Math.max(1, Math.min(250, box.h));
    return {
      x: box.x + (box.w - w) / 2,
      y: box.y + (box.h - h) / 2,
      w,
      h
    };
  }

  private withMaxImageBounds(
    box: { x: number; y: number; w: number; h: number },
    natW: number,
    natH: number
  ): { x: number; y: number; w: number; h: number } {
    const safeNatW = Math.max(1, natW);
    const safeNatH = Math.max(1, natH);
    const scale = Math.min(400 / safeNatW, 250 / safeNatH, 1);
    const w = Math.max(10, Math.round(safeNatW * scale));
    const h = Math.max(10, Math.round(safeNatH * scale));
    return {
      x: box.x + (box.w - w) / 2,
      y: box.y + (box.h - h) / 2,
      w,
      h
    };
  }

  private hitTestDetectedMedia(pageIndex: number, x: number, y: number): DetectedPdfMedia | null {
    const items = this.detectedMediaByPage()[pageIndex] ?? [];
    let best: DetectedPdfMedia | null = null;
    let bestArea = Infinity;
    for (const it of items) {
      if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) {
        const area = Math.max(1, it.w) * Math.max(1, it.h);
        if (area < bestArea) {
          bestArea = area;
          best = it;
        }
      }
    }
    return best;
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
      fontFamily: FontFamily;
      text: string;
      fillColor?: string;
      /** Large PDF vertical gap before this line → blank line in merged block text */
      paragraphGapBefore?: boolean;
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
          fontFamily: s.fontFamily,
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
        const families: FontFamily[] = [];
        let prevR = -Infinity;
        for (const sp of seg) {
          x0 = Math.min(x0, sp.x);
          y0 = Math.min(y0, sp.y);
          x1 = Math.max(x1, sp.x + sp.w);
          y1 = Math.max(y1, sp.y + sp.h);
          maxFs = Math.max(maxFs, sp.fontSize);
          fs.push(sp.fontStyle);
          families.push(sp.fontFamily);

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
          fontFamily: dominantFontFamily(families),
          text: text.trim()
        });
      }
    }

    // Replace with segmented/finalized lines.
    lines.length = 0;
    lines.push(...finalizedLines);

    // Group lines into blocks (paragraph/list/heading-ish).
    const indentTol = Math.max(10, medianFont * 0.9);

    const blocks: DetectedBlock[] = [];
    let cur:
      | { lines: typeof lines; x0: number; y0: number; x1: number; y1: number; fontSize: number }
      | null = null;

    const pushCur = () => {
      if (!cur || cur.lines.length === 0) return;
      const chunks: string[] = [];
      for (const l of cur.lines) {
        const t = l.text?.trim();
        if (!t) continue;
        if (chunks.length === 0) {
          chunks.push(t);
        } else {
          const sep = l.paragraphGapBefore ? '\n\n' : '\n';
          chunks.push(`${sep}${t}`);
        }
      }
      const allText = chunks.join('');
      const firstText = cur.lines[0]?.text ?? '';
      const isList = /^(\s*([-•]|(\d+)[.)]))\s+/.test(firstText);
      const isHeading = cur.fontSize >= medianFont * 1.25 && allText.length <= 120;
      const kind: DetectedBlockKind = isHeading ? 'heading' : isList ? 'list' : 'paragraph';
      const blockStyle = dominantFontStyle(cur.lines.map((l) => l.fontStyle));
      const blockFamily = dominantFontFamily(cur.lines.map((l) => l.fontFamily));
      blocks.push({
        x: cur.x0,
        y: cur.y0,
        w: Math.max(1, cur.x1 - cur.x0),
        h: Math.max(1, cur.y1 - cur.y0),
        text: allText.trim(),
        fontSize: cur.fontSize,
        fontStyle: blockStyle,
        fontFamily: blockFamily,
        kind
      });
    };
    function normalizeFillColorKey(c: string | undefined): string {
      if (!c || typeof c !== 'string') return '';
      return c.trim().toLowerCase();
    }
    for (const ln of lines) {
      if (!ln.text) continue;
      if (!cur) {
        cur = { lines: [ln] as any, x0: ln.x0, y0: ln.y0, x1: ln.x1, y1: ln.y1, fontSize: ln.fontSize };
        continue;
      }
      const prev = cur.lines[cur.lines.length - 1]!;
      const indentDelta = Math.abs(ln.x0 - cur.lines[0]!.x0);
      const previousIndentDelta = Math.abs(ln.x0 - prev.x0);
      // Viewport y grows downward: extra space between line bottoms and the next line top
      // means a paragraph / section gap; wrapped lines stay within ~one line advance.
      const verticalGap = ln.y0 - prev.y1;
      const lineAdvance = Math.max(prev.fontSize, ln.fontSize, medianFont * 0.5);
      const paragraphVerticalGap =
        verticalGap > Math.max(6, lineAdvance * 0.65);

      const sizeChanged = Math.round(ln.fontSize) !== Math.round(prev.fontSize);
      const fillChanged =
        normalizeFillColorKey(ln.fillColor) !== normalizeFillColorKey(prev.fillColor);
      const sameStyle =
        !sizeChanged &&
        !fillChanged &&
        ln.fontStyle === prev.fontStyle &&
        ln.fontFamily === prev.fontFamily;
      const startsListItem = /^(\s*([-•]|(\d+)[.)]))\s+/.test(ln.text ?? '');
      const verticalFlowContinues = verticalGap <= Math.max(18, lineAdvance * 1.8);
      const likelyNewColumn = ln.x0 > prev.x1 + Math.max(24, medianFont * 2.5);
      const largeStylePreservingJump =
        indentDelta > Math.max(indentTol * 3.5, medianFont * 4) &&
        previousIndentDelta > Math.max(indentTol * 2, medianFont * 2.5);
      // Keep same-style paragraph/list content together. Preserve section hierarchy by splitting on
      // clear style changes, new list items, column jumps, or very large indentation shifts.
      const isListLine = (text: string) =>
        /^(\s*([-•●◦▪]|\d+[.)]))\s+/.test(text ?? '');

      const curIsList = cur.lines.some((l) => isListLine(l.text ?? ''));
      const nextIsList = isListLine(ln.text ?? '');

      const sameListFlow =
        curIsList &&
        nextIsList &&
        sameStyle &&
        verticalFlowContinues &&
        Math.abs(ln.x0 - cur.lines[0]!.x0) <= Math.max(indentTol * 1.5, medianFont * 2);

      const sameLeftFlow =
        Math.abs(ln.x0 - cur.lines[0]!.x0) <= Math.max(3, medianFont * 0.35);

      const continuingText =
        sameLeftFlow &&
        verticalFlowContinues &&
        sameStyle &&
        !likelyNewColumn;

      const newBlock =
        sizeChanged ||
        fillChanged ||
        likelyNewColumn ||
        !verticalFlowContinues ||
        (!continuingText && (sameStyle ? largeStylePreservingJump : indentDelta > indentTol));


      if (newBlock) {
        pushCur();
        cur = { lines: [ln] as any, x0: ln.x0, y0: ln.y0, x1: ln.x1, y1: ln.y1, fontSize: ln.fontSize };
      } else {
        cur.lines.push({ ...ln, paragraphGapBefore: paragraphVerticalGap } as any);
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

  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read file.'));
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.readAsDataURL(file);
    });
  }

  private async requestImageCrop(dataUrl: string): Promise<string | null> {
    // If the crop UI is not present in the current template build, do not block the
    // image replacement flow waiting for a resolver that can never be triggered.
    if (!this.uploadCropSurface?.nativeElement) return dataUrl;
    const existing = this.imageUploadCropResolve;
    if (existing) existing(null);
    return new Promise<string | null>((resolve) => {
      this.imageUploadCropResolve = resolve;
      this.imageUploadCropModal.set({
        dataUrl,
        leftPct: 0,
        topPct: 0,
        rightPct: 0,
        bottomPct: 0
      });
    });
  }

  protected patchUploadCropField(
    field: 'leftPct' | 'topPct' | 'rightPct' | 'bottomPct',
    value: number
  ) {
    const cur = this.imageUploadCropModal();
    if (!cur) return;
    this.imageUploadCropModal.set({
      ...cur,
      [field]: clamp(Number.isFinite(value) ? value : 0, 0, 49)
    });
  }

  protected uploadCropBoxStyle() {
    const crop = this.imageUploadCropModal();
    if (!crop) return {};
    const width = Math.max(1, 100 - crop.leftPct - crop.rightPct);
    const height = Math.max(1, 100 - crop.topPct - crop.bottomPct);
    return {
      left: `${crop.leftPct}%`,
      top: `${crop.topPct}%`,
      width: `${width}%`,
      height: `${height}%`
    };
  }

  protected onUploadCropHandlePointerDown(handle: 'tl' | 'tr' | 'bl' | 'br', ev: PointerEvent) {
    const crop = this.imageUploadCropModal();
    if (!crop) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.activeUploadCropHandle = {
      pointerId: ev.pointerId,
      handle,
      startClientX: ev.clientX,
      startClientY: ev.clientY,
      start: {
        leftPct: crop.leftPct,
        topPct: crop.topPct,
        rightPct: crop.rightPct,
        bottomPct: crop.bottomPct
      }
    };
    (ev.target as HTMLElement | null)?.setPointerCapture?.(ev.pointerId);
  }

  protected cancelImageUploadCrop(ev?: Event) {
    ev?.preventDefault();
    ev?.stopPropagation();
    this.activeUploadCropHandle = null;
    const resolve = this.imageUploadCropResolve;
    this.imageUploadCropResolve = null;
    this.imageUploadCropModal.set(null);
    resolve?.(null);
  }

  protected async applyImageUploadCrop(ev?: Event) {
    ev?.preventDefault();
    ev?.stopPropagation();
    this.activeUploadCropHandle = null;
    const cur = this.imageUploadCropModal();
    if (!cur) return;
    const resolve = this.imageUploadCropResolve;
    this.imageUploadCropResolve = null;
    this.imageUploadCropModal.set(null);
    try {
      const img = await this.loadHtmlImage(cur.dataUrl);
      const sw = Math.max(1, img.naturalWidth);
      const sh = Math.max(1, img.naturalHeight);
      let l = clamp(cur.leftPct, 0, 49);
      let t = clamp(cur.topPct, 0, 49);
      let r = clamp(cur.rightPct, 0, 49);
      let b = clamp(cur.bottomPct, 0, 49);
      if (l + r >= 99.5) r = Math.max(0, 99.5 - l);
      if (t + b >= 99.5) b = Math.max(0, 99.5 - t);
      const sx = Math.round((l / 100) * sw);
      const sy = Math.round((t / 100) * sh);
      const cw = Math.max(1, Math.round((1 - (l + r) / 100) * sw));
      const ch = Math.max(1, Math.round((1 - (t + b) / 100) * sh));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve?.(null);
        return;
      }
      ctx.drawImage(img, sx, sy, cw, ch, 0, 0, cw, ch);
      resolve?.(canvas.toDataURL('image/png'));
    } catch {
      resolve?.(null);
    }
  }

  private async readAndCropImageFile(file: File): Promise<string | null> {
    const dataUrl = await this.readFileAsDataUrl(file);
    if (!/^data:image\/(png|jpeg);base64,/i.test(dataUrl)) {
      this.errorText.set('Unsupported image (use PNG or JPEG).');
      return null;
    }
    return await this.requestImageCrop(dataUrl);
  }

  /** Places an image on the PDF overlay (same as the Image tool and PNG/JPEG drop). `src` may be a data URL or a usable image URL. */
  private async placeImageSrcAtPoint(pageIndex: number, x: number, y: number, src: string): Promise<void> {
    const trimmed = src.trim();
    if (!trimmed) return;
    const { overlay } = this.getCanvasPair(pageIndex);
    if (!overlay) return;
    const { w: pageCssW, h: pageCssH } = this.overlayNominalCssSize(overlay);

    let img: HTMLImageElement;
    try {
      img = await this.loadHtmlImage(trimmed);
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to decode image.');
      return;
    }

    const maxW = 400;
    const maxH = 250;
    const natW = Math.max(1, img.naturalWidth);
    const natH = Math.max(1, img.naturalHeight);
    const scale = Math.min(maxW / natW, maxH / natH, 1);
    const w = Math.max(10, Math.round(natW * scale));
    const h = Math.max(10, Math.round(natH * scale));
    const cx = x - w / 2;
    const cy = y - h / 2;
    const px = clamp(cx, 0, Math.max(0, pageCssW - w));
    const py = clamp(cy, 0, Math.max(0, pageCssH - h));
    const id = this.newPlacedImageId();
    const anno: ImageAnno = {
      id,
      x: px,
      y: py,
      w,
      h,
      dataUrl: trimmed,
      srcW: img.naturalWidth,
      srcH: img.naturalHeight
    };
    this.pushImageAnno(pageIndex, anno);
    this.selectedWidgetId.set(null);
    this.selectedPlacedImageId.set(id);
    this.tool.set('text');
    this.redrawOverlay(pageIndex);
    this.cdr.markForCheck();
  }

  private async placePendingImage(pageIndex: number, x: number, y: number) {
    const src = this.pendingImageDataUrl;
    if (!src) return;
    this.pendingImageDataUrl = null;
    await this.placeImageSrcAtPoint(pageIndex, x, y, src);
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
    const sel = this.selectedPlacedImage();
    if (!sel) return;
    this.openPlacedImageCropSession(sel.pageIndex, sel.image.id);
  }

  private openPlacedImageCropSession(pageIndex: number, id: string) {
    const anno = this.getImageAnno(pageIndex, id);
    if (!anno) return;
    const sw = Math.max(1, anno.srcW);
    const sh = Math.max(1, anno.srcH);
    const c = anno.crop ?? { x: 0, y: 0, w: sw, h: sh };
    this.imageCropSession.set({
      mode: 'placed',
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
    let l = clamp(s.leftPct, 0, 49);
    let t = clamp(s.topPct, 0, 49);
    let r = clamp(s.rightPct, 0, 49);
    let b = clamp(s.bottomPct, 0, 49);
    if (l + r >= 99.5) r = Math.max(0, 99.5 - l);
    if (t + b >= 99.5) b = Math.max(0, 99.5 - t);

    if (s.mode === 'placed') {
      const anno = this.getImageAnno(s.pageIndex, s.id);
      if (!anno) return;
      const sw = Math.max(1, anno.srcW);
      const sh = Math.max(1, anno.srcH);
      const cx = (l / 100) * sw;
      const cy = (t / 100) * sh;
      const cw = Math.max(1, (1 - (l + r) / 100) * sw);
      const ch = Math.max(1, (1 - (t + b) / 100) * sh);
      this.beginHistoryStep();
      this.updatePlacedImage(s.pageIndex, s.id, (a) => ({
        ...a,
        crop: {
          x: Math.round(cx),
          y: Math.round(cy),
          w: Math.round(cw),
          h: Math.round(ch)
        }
      }));
      this.imageCropSession.set(null);
      this.redrawOverlay(s.pageIndex);
      return;
    }
  }

  protected cancelImageCrop() {
    this.imageCropSession.set(null);
  }

  protected removeSelectedPlacedImage(ev?: Event) {
    ev?.preventDefault();
    ev?.stopPropagation();
    const sel = this.selectedPlacedImage();
    if (!sel) return;
    const { pageIndex, image } = sel;
    const id = image.id;
    if (this.activePlacedImageOp?.pageIndex === pageIndex && this.activePlacedImageOp.id === id) {
      this.activePlacedImageOp = null;
    }
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
    vp: { width: number; height: number; convertToPdfPoint: (x: number, y: number) => number[] }
  ) {
    if ((edit.images?.length ?? 0) === 0) return;

    for (const img of edit.images) {
      const embedded = await this.embedPlacedImageForPdf(pdf, img);
      const rect = this.editorRectToPdfAabb(vp, img.x, img.y, img.w, img.h);
      page.drawImage(embedded, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      });
    }
  }

  /** Headers, footers, page numbers, and logo — matches flattened export and editor furniture layer. */
  private async drawSemanticPageFurnitureToPdf(
    pdf: PDFDocument,
    page: PDFPage,
    vp: { width: number; height: number; convertToPdfPoint: (x: number, y: number) => number[] },
    pageIndex: number,
    edit: PageEdits | undefined,
    font: PDFFont
  ) {
    const furniture = this.pageFurniture();
    const editW = Math.max(1, edit?.viewportWidth ?? vp.width);
    const editH = Math.max(1, edit?.viewportHeight ?? vp.height);
    const pad = 20;
    const scalePub = Math.min(vp.width / editW, vp.height / editH);
    const sizePdf = Math.max(8, 12 * scalePub);
    const ink = { r: 0.06, g: 0.09, b: 0.16 };

    if (furniture.logo.visible && furniture.logo.url) {
      try {
        const img = await this.loadHtmlImage(furniture.logo.url);
        const c = document.createElement('canvas');
        c.width = Math.max(1, img.naturalWidth || img.width);
        c.height = Math.max(1, img.naturalHeight || img.height);
        const cctx = c.getContext('2d');
        if (cctx) {
          cctx.drawImage(img, 0, 0);
          const png = c.toDataURL('image/png');
          const { bytes } = this.dataUrlToBytes(png);
          const embedded = await pdf.embedPng(bytes);
          const lw = furniture.logo.width;
          const lh = furniture.logo.height;
          const lx = furniture.logo.position === 'header-right' ? editW - pad - lw : pad;
          const ly = 10;
          const box = this.editorRectToPdfAabb(vp, lx, ly, lw, lh);
          page.drawImage(embedded, { x: box.x, y: box.y, width: box.width, height: box.height });
        }
      } catch {
        // ignore
      }
    }

    if (furniture.header.visible) {
      const text = this.furnitureText(furniture.header.content, pageIndex);
      const align = furniture.header.alignment;
      const anchorX = align === 'center' ? editW / 2 : pad;
      const hAlign: 'left' | 'center' | 'right' =
        align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
      this.drawSemanticViewportTextLine(page, vp, text, anchorX, 16, hAlign, 12, sizePdf, font, ink, editW - pad * 2);
    }

    if (furniture.footer.visible) {
      if (furniture.footer.divider) {
        const a = vp.convertToPdfPoint(pad, editH - 40);
        const b = vp.convertToPdfPoint(editW - pad, editH - 40);
        page.drawLine({
          start: { x: a[0], y: a[1] },
          end: { x: b[0], y: b[1] },
          thickness: Math.max(0.5, scalePub),
          color: rgb(0.55, 0.58, 0.62)
        });
      }
      const fy = editH - 24;
      const third = (editW - pad * 2) / 3;
      this.drawSemanticViewportTextLine(
        page,
        vp,
        this.furnitureText(furniture.footer.leftContent, pageIndex),
        pad,
        fy,
        'left',
        12,
        sizePdf,
        font,
        ink,
        third
      );
      this.drawSemanticViewportTextLine(
        page,
        vp,
        this.furnitureText(furniture.footer.centerContent, pageIndex),
        pad + third + third / 2,
        fy,
        'center',
        12,
        sizePdf,
        font,
        ink,
        third
      );
      this.drawSemanticViewportTextLine(
        page,
        vp,
        this.furnitureText(furniture.footer.rightContent, pageIndex),
        pad + 2 * third,
        fy,
        'right',
        12,
        sizePdf,
        font,
        ink,
        third
      );
    }

    const pageLabel = this.pageNumberLabel(pageIndex);
    if (pageLabel) {
      const pos = furniture.pageNumber.position;
      if (pos === 'header-left') {
        this.drawSemanticViewportTextLine(page, vp, pageLabel, pad, 16, 'left', 12, sizePdf, font, ink, editW - pad * 2);
      } else if (pos === 'header-right') {
        this.drawSemanticViewportTextLine(page, vp, pageLabel, pad, 16, 'right', 12, sizePdf, font, ink, editW - pad * 2);
      } else if (pos === 'footer-left') {
        this.drawSemanticViewportTextLine(page, vp, pageLabel, pad, editH - 24, 'left', 12, sizePdf, font, ink, editW - pad * 2);
      } else if (pos === 'footer-center') {
        this.drawSemanticViewportTextLine(page, vp, pageLabel, editW / 2, editH - 24, 'center', 12, sizePdf, font, ink, editW - pad * 2);
      } else {
        this.drawSemanticViewportTextLine(page, vp, pageLabel, pad, editH - 24, 'right', 12, sizePdf, font, ink, editW - pad * 2);
      }
    }
  }

  protected derivedProposalTitle(): string {
    return (this.fileName() ?? 'Proposal').replace(/\.pdf$/i, '');
  }

  private syncProposalTitleWithMainTitle(previousDerivedTitle: string) {
    this.pageFurniture.update((prev) => {
      const current = (prev.proposalTitle ?? '').trim();
      if (current.length > 0 && current !== previousDerivedTitle) return prev;
      const next = this.derivedProposalTitle();
      if (current === next) return prev;
      return { ...prev, proposalTitle: next };
    });
  }

  private normalizePageFurniture(raw: unknown): PageFurniture {
    const fallback = clonePageFurniture(DEFAULT_PAGE_FURNITURE);
    if (!raw || typeof raw !== 'object') return fallback;
    const r = raw as Partial<PageFurniture>;
    const legacy = raw as Record<string, unknown>;
    const num = (v: unknown, d: number, min = 0) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(min, n) : d;
    };
    const text = (...candidates: unknown[]): string | null => {
      for (const candidate of candidates) {
        if (typeof candidate === 'string') return candidate;
      }
      return null;
    };
    return {
      proposalTitle: text(r.proposalTitle, legacy['projectName'], legacy['project_title']) ?? fallback.proposalTitle,
      clientName: text(r.clientName, legacy['client'], legacy['client_name'], legacy['customerName']) ?? fallback.clientName,
      header: {
        content: typeof r.header?.content === 'string' ? r.header.content : fallback.header.content,
        alignment: (['left', 'center', 'right'] as const).includes(r.header?.alignment as any)
          ? (r.header!.alignment as FurnitureAlignment)
          : fallback.header.alignment,
        visible: typeof r.header?.visible === 'boolean' ? r.header.visible : fallback.header.visible
      },
      footer: {
        leftContent: typeof r.footer?.leftContent === 'string' ? r.footer.leftContent : fallback.footer.leftContent,
        centerContent:
          typeof r.footer?.centerContent === 'string' ? r.footer.centerContent : fallback.footer.centerContent,
        rightContent:
          typeof r.footer?.rightContent === 'string' ? r.footer.rightContent : fallback.footer.rightContent,
        visible: typeof r.footer?.visible === 'boolean' ? r.footer.visible : fallback.footer.visible,
        divider: typeof r.footer?.divider === 'boolean' ? r.footer.divider : fallback.footer.divider
      },
      pageNumber: {
        visible: typeof r.pageNumber?.visible === 'boolean' ? r.pageNumber.visible : fallback.pageNumber.visible,
        format: (['1', '1 / N', 'Page 1 of N'] as const).includes(r.pageNumber?.format as any)
          ? (r.pageNumber!.format as PageNumberFormat)
          : fallback.pageNumber.format,
        position: (['header-left', 'header-right', 'footer-left', 'footer-center', 'footer-right'] as const).includes(
          r.pageNumber?.position as any
        )
          ? (r.pageNumber!.position as PageNumberPosition)
          : fallback.pageNumber.position,
        startFrom: num(r.pageNumber?.startFrom, fallback.pageNumber.startFrom, 1)
      },
      logo: {
        url: typeof r.logo?.url === 'string' ? r.logo.url : fallback.logo.url,
        position: (['header-left', 'header-right'] as const).includes(r.logo?.position as any)
          ? (r.logo!.position as 'header-left' | 'header-right')
          : fallback.logo.position,
        width: num(r.logo?.width, fallback.logo.width, 24),
        height: num(r.logo?.height, fallback.logo.height, 16),
        keepAspectRatio:
          typeof r.logo?.keepAspectRatio === 'boolean' ? r.logo.keepAspectRatio : fallback.logo.keepAspectRatio,
        linkUrl: typeof r.logo?.linkUrl === 'string' ? r.logo.linkUrl : fallback.logo.linkUrl,
        visible: typeof r.logo?.visible === 'boolean' ? r.logo.visible : fallback.logo.visible
      }
    };
  }

  private coerceFurnitureTextValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && 'target' in value) {
      const maybeTarget = (value as { target?: unknown }).target;
      if (maybeTarget && typeof maybeTarget === 'object' && 'value' in maybeTarget) {
        const next = (maybeTarget as { value?: unknown }).value;
        if (typeof next === 'string') return next;
      }
    }
    return '';
  }

  private syncDynamicFieldDrafts(furniture: PageFurniture) {
    this.proposalTitleDraft.set(furniture.proposalTitle ?? '');
    this.clientNameDraft.set(furniture.clientName ?? '');
  }

  private scheduleFurnitureSave(id: string, furniture: PageFurniture) {
    if (this.furnitureSaveTimer) clearTimeout(this.furnitureSaveTimer);
    const snapshot = this.normalizePageFurniture(furniture);
    this.furnitureSaveTimer = setTimeout(() => {
      void this.api.putFurniture(id, snapshot).catch(() => {
        // non-fatal
      });
    }, 350);
  }

  private pageFurnitureStorageKey(id: string): string {
    return `avyro:pdf-page-furniture:v1:${id}`;
  }

  private titleStorageKey(id: string): string {
    return `avyro:pdf-title:v1:${id}`;
  }

  private editorStatePayloadIsMeaningful(remote: PdfEditorStateV2 | null): boolean {
    if (!remote || typeof remote !== 'object') return false;
    const widgets = remote.widgetsByPage as Record<string, unknown> | undefined;
    if (widgets && Object.values(widgets).some((list) => Array.isArray(list) && list.length > 0)) return true;
    const edits = remote.editsByPage as Record<string, unknown> | undefined;
    if (!edits) return false;
    return Object.values(edits).some((edit) => {
      if (!edit || typeof edit !== 'object') return false;
      const e = edit as PageEdits;
      return (
        (e.ink?.length ?? 0) > 0 ||
        (e.text?.length ?? 0) > 0 ||
        (e.images?.length ?? 0) > 0 ||
        (e.replaces?.length ?? 0) > 0
      );
    });
  }

  private async parseEditorStateForLoad(
    remote: PdfEditorStateV2 | null,
    pageCount: number
  ): Promise<{ editsByPage: Record<number, PageEdits>; widgetsByPage: Record<number, Widget[]> }> {
    if (!remote || remote.version !== 2) {
      return { editsByPage: {}, widgetsByPage: {} };
    }
    const stateWidgets = (remote.widgetsByPage ?? {}) as unknown as PersistedMediaWidgetsByPage;
    const editsByPage = this.normalizePersistedEdits(
      remote.editsByPage as unknown as Record<number, PageEdits> | undefined,
      pageCount
    );
    const widgetsByPage = await this.normalizePersistedWidgets(stateWidgets, pageCount);
    return { editsByPage, widgetsByPage };
  }

  private async persistEditorStateToRemote(
    id: string,
    editsByPage: Record<number, PageEdits>,
    widgetsByPage: Record<number, Widget[]>,
    fileName: string | null | undefined
  ): Promise<void> {
    if (this.readonlyMode()) return;
    const widgetsOut: PersistedMediaWidgetsByPage = {};
    for (const [k, list] of Object.entries(widgetsByPage)) {
      const pageIndex = Number(k);
      const widgets: PersistedWidget[] = [];
      for (const w of list ?? []) {
        if (w.kind !== 'table' && w.kind !== 'text') continue;
        widgets.push({
          id: w.id,
          kind: w.kind,
          x: w.x,
          y: w.y,
          w: w.w,
          h: w.h,
          textValue: w.kind === 'text' ? w.textValue : undefined,
          table: w.kind === 'table' && w.table ? this.cloneTable(w.table) : undefined
        });
      }
      if (widgets.length > 0) widgetsOut[pageIndex] = widgets;
    }
    const fn = (fileName ?? '').trim();
    const payload: PdfEditorStateV2 = {
      version: 2,
      ...(fn ? { fileName: fn } : {}),
      editsByPage: this.cloneEdits(editsByPage) as unknown as Record<string, unknown>,
      widgetsByPage: widgetsOut as unknown as Record<string, unknown>
    };
    await this.api.putEditorState(id, payload);
  }

  private async normalizePersistedWidgets(
    parsed: Record<number, PersistedWidget[]> | undefined,
    pageCount: number
  ): Promise<Record<number, Widget[]>> {
    const out: Record<number, Widget[]> = {};
    for (const [k, list] of Object.entries(parsed ?? {})) {
      const pageIndex = Number(k);
      if (!Number.isFinite(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) continue;
      const widgets: Widget[] = [];
      for (const w of list ?? []) {
        if (!w || !this.isPersistableWidgetKind(w.kind)) continue;
        widgets.push({
          id: w.id,
          kind: w.kind,
          x: Number.isFinite(w.x) ? w.x : 0,
          y: Number.isFinite(w.y) ? w.y : 0,
          w: Number.isFinite(w.w) ? w.w : w.kind === 'table' ? 400 : 300,
          h: Number.isFinite(w.h) ? w.h : w.kind === 'table' ? 220 : 160,
          textValue: w.kind === 'text' ? String(w.textValue ?? '') : undefined,
          table: w.kind === 'table' ? this.normalizePersistedTable(w.table) : undefined
        });
      }
      if (widgets.length > 0) out[pageIndex] = widgets;
    }
    return out;
  }

  private normalizePersistedEdits(raw: Record<number, PageEdits> | undefined, pageCount: number): Record<number, PageEdits> {
    const out: Record<number, PageEdits> = {};
    for (const [k, edit] of Object.entries(raw ?? {})) {
      const pageIndex = Number(k);
      if (!Number.isFinite(pageIndex) || pageIndex < 0 || pageIndex >= pageCount || !edit) continue;
      const replaces = Array.isArray(edit.replaces)
        ? edit.replaces.map((r) =>
            r?.source === 'textEdit' ? { ...r, maskMode: 'color' as const, bgColor: '#ffffff' } : r
          )
        : [];
      const images = Array.isArray(edit.images)
        ? edit.images
            .filter((img): img is ImageAnno => {
              if (!img || typeof (img as ImageAnno).id !== 'string') return false;
              if (typeof (img as ImageAnno).dataUrl !== 'string') return false;
              if (!/^data:image\/(png|jpeg);base64,/i.test((img as ImageAnno).dataUrl)) return false;
              return (
                Number.isFinite((img as ImageAnno).x) &&
                Number.isFinite((img as ImageAnno).y) &&
                Number.isFinite((img as ImageAnno).w) &&
                Number.isFinite((img as ImageAnno).h)
              );
            })
            .map((img) => ({
              id: img.id,
              x: img.x,
              y: img.y,
              w: Math.max(1, img.w),
              h: Math.max(1, img.h),
              dataUrl: img.dataUrl,
              srcW: Number.isFinite(img.srcW) && img.srcW > 0 ? img.srcW : 1,
              srcH: Number.isFinite(img.srcH) && img.srcH > 0 ? img.srcH : 1,
              crop: img.crop
                ? {
                    x: Number.isFinite(img.crop.x) ? img.crop.x : 0,
                    y: Number.isFinite(img.crop.y) ? img.crop.y : 0,
                    w: Number.isFinite(img.crop.w) && img.crop.w > 0 ? img.crop.w : 1,
                    h: Number.isFinite(img.crop.h) && img.crop.h > 0 ? img.crop.h : 1
                  }
                : undefined
            }))
        : [];
      out[pageIndex] = {
        viewportWidth: Number.isFinite(edit.viewportWidth) ? edit.viewportWidth : 1,
        viewportHeight: Number.isFinite(edit.viewportHeight) ? edit.viewportHeight : 1,
        ink: Array.isArray(edit.ink) ? edit.ink : [],
        text: Array.isArray(edit.text)
          ? edit.text.map((t, i) =>
            t && typeof (t as TextAnno).id === 'string' && (t as TextAnno).id
              ? t
              : { ...(t as TextAnno), id: `txt_${pageIndex}_${i}_${Math.random().toString(16).slice(2, 10)}` }
          )
          : [],
        images,
        replaces
      };
    }
    return out;
  }

  private cloneTable(table: { rows: number; cols: number; cells: string[][] }) {
    return {
      rows: table.rows,
      cols: table.cols,
      cells: table.cells.map((row) => row.map((cell) => String(cell ?? '')))
    };
  }

  private normalizePersistedTable(table: PersistedWidget['table']) {
    const rows = clamp(Math.floor(Number(table?.rows ?? 3)), 1, 80);
    const cols = clamp(Math.floor(Number(table?.cols ?? 3)), 1, 40);
    const rawCells = Array.isArray(table?.cells) ? table.cells : [];
    const cells = Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => String(rawCells[r]?.[c] ?? ''))
    );
    return { rows, cols, cells };
  }

  private isPersistableWidgetKind(kind: unknown): kind is WidgetKind {
    return kind === 'table' || kind === 'text';
  }

  private editorStateStorageKey(id: string): string {
    return `avyro:pdf-editor-state:v2:${id}`;
  }

  private legacyMediaWidgetsStorageKey(id: string): string {
    return `avyro:pdf-media-widgets:v1:${id}`;
  }

  private persistedVideoRef(docId: string, widgetId: string): string {
    return `idb-video:${docId}:${widgetId}`;
  }

  private async pdfBytesLookEditableForDetection(bytes: Uint8Array): Promise<boolean> {
    let doc: PDFDocumentProxy | null = null;
    try {
      const loadingTask = getDocument({ data: this.clonePdfBytes(bytes) });
      doc = await loadingTask.promise;
      const pagesToCheck = Math.min(5, doc.numPages);
      let meaningfulText = 0;
      let editableMedia = 0;
      for (let pageIndex = 0; pageIndex < pagesToCheck; pageIndex++) {
        const page = await doc.getPage(pageIndex + 1);
        try {
          const textContent = await page.getTextContent();
          for (const it of textContent.items as any[]) {
            const text = String(it?.str ?? '').replace(/\s+/g, ' ').trim();
            if (!/[a-z]{3,}/i.test(text)) continue;
            if (/^\d+\s*\/\s*\d+$/.test(text)) continue;
            meaningfulText++;
            if (meaningfulText >= 3) return true;
          }
        } catch {
          // keep checking media
        }
        try {
          const viewport = this.getCssViewportForPdfPage(page as any);
          const opList = await (page as any).getOperatorList();
          editableMedia += this.collectImageRectsFromOperatorList(opList, viewport).filter(
            (r) => !this.isWholePageLikeMediaRect(r, viewport)
          ).length;
          if (editableMedia > 0) return true;
        } catch {
          // ignore candidate inspection failures
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      try {
        await doc?.destroy();
      } catch {
        // ignore
      }
    }
  }

  private openPersistedVideoDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.persistedVideoDbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.persistedVideoStoreName)) {
          db.createObjectStore(this.persistedVideoStoreName);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Failed to open media storage.'));
    });
  }

  private async putPersistedVideoDataUrl(ref: string, dataUrl: string): Promise<void> {
    try {
      const db = await this.openPersistedVideoDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(this.persistedVideoStoreName, 'readwrite');
        const store = tx.objectStore(this.persistedVideoStoreName);
        const req = store.put(dataUrl, ref);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error('Failed to persist video.'));
      });
      db.close();
    } catch {
      // ignore storage issues
    }
  }

  private async getPersistedVideoDataUrl(ref: string): Promise<string | undefined> {
    try {
      const db = await this.openPersistedVideoDb();
      const value = await new Promise<string | undefined>((resolve, reject) => {
        const tx = db.transaction(this.persistedVideoStoreName, 'readonly');
        const store = tx.objectStore(this.persistedVideoStoreName);
        const req = store.get(ref);
        req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : undefined);
        req.onerror = () => reject(req.error ?? new Error('Failed to load persisted video.'));
      });
      db.close();
      return value;
    } catch {
      return undefined;
    }
  }

  private async blobUrlToDataUrl(blobUrl: string): Promise<string | undefined> {
    try {
      const res = await fetch(blobUrl);
      if (!res.ok) return undefined;
      const blob = await res.blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob media.'));
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.readAsDataURL(blob);
      });
    } catch {
      return undefined;
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
