/**
 * Slide-based proposal content model (new element pipeline).
 *
 * Existing PDF editor widget text/image/video flows are untouched; consumers
 * instantiate these types for proposals or future integrations.
 */

export type ProposalElementType =
  | 'text'
  | 'video'
  | 'image'
  | 'textOverlayImage'
  | 'backgroundImageText';

export interface ProposalElementPosition {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}

/** Canonical HTML subset for proposal text blocks (sanitized upstream in production APIs). */
export interface ProposalTextRichContent {
  html: string;
}

export interface ProposalTextStyle {
  fontFamily?: string;
  fontSizePx?: number;
  color?: string;
  letterSpacingPx?: number;
  lineHeight?: number | string;
  paddingPx?: number;
}

export interface ProposalVideoContent {
  /** User-facing editable source — upload URL or direct MP4/stream URL after upload. */
  sourceUrl?: string;
  /** YouTube / Vimeo URL when embedding a provider (optional mirror of canonical URL). */
  embedUrl?: string;
  thumbnailUrl?: string;
  caption?: string;
  /** How the user sourced the video — drives inspector UI (`embed` = paste URL, `upload` = file / gallery pick). */
  videoSourceMode?: 'embed' | 'upload';
  /** Original filename when sourced via upload (preview only until persisted as an asset URL). */
  uploadedFileName?: string;
  /** MIME type reported by the browser for the picked file (optional, for uploads). */
  uploadMimeType?: string;
}

export interface ProposalVideoStyle {
  objectFit?: 'contain' | 'cover';
}

export interface ProposalImageContent {
  /** Resolved display URL after asset pick or upload (https, data URL, or temporary blob: URL). */
  src?: string;
  assetLibraryId?: string;
  alt?: string;
  /** `link` = paste URL · `upload` = file / gallery (may open crop first). */
  imageSourceMode?: 'link' | 'upload';
  /** Original filename when added from an upload (gallery / Files). */
  uploadedFileName?: string;
  uploadMimeType?: string;
}

export interface ProposalImageStyle {
  borderRadiusPx?: number;
  boxShadow?: string;
}

export interface ProposalTextOverlayPosition {
  preset?: 'top' | 'center' | 'bottom' | 'custom';
  /** 0–1 along X/Y when preset is custom — relative to the image frame. */
  anchorX?: number;
  anchorY?: number;
}

export interface ProposalTextOverlayImageContent {
  imageSrc?: string;
  assetLibraryId?: string;
  /** Rich HTML for overlay (same contract as ProposalTextRichContent.html). */
  overlayHtml?: string;
  overlayPosition?: ProposalTextOverlayPosition;
}

export interface ProposalTextOverlayImageStyle {
  /** Darkens or lightens the image behind text for readability. */
  overlayMaskOpacity?: number;
  overlayMaskTone?: 'dark' | 'light' | 'none';
  /** Inner padding inside the framed element for the overlay area. */
  contentPaddingPx?: number;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
}

export interface ProposalBackgroundImageTextContent {
  imageSrc?: string;
  assetLibraryId?: string;
  overlayHtml?: string;
}

export interface ProposalBackgroundImageTextStyle {
  backgroundSize?: 'cover' | 'contain';
  overlayOpacity?: number;
  overlayColor?: string;
  innerPaddingPx?: number;
  textMaxWidthPx?: number | string;
}

export interface ProposalTextElementModel {
  id: string;
  type: 'text';
  content: ProposalTextRichContent;
  style: ProposalTextStyle;
  position: ProposalElementPosition;
}

export interface ProposalVideoElementModel {
  id: string;
  type: 'video';
  content: ProposalVideoContent;
  style: ProposalVideoStyle;
  position: ProposalElementPosition;
}

export interface ProposalImageElementModel {
  id: string;
  type: 'image';
  content: ProposalImageContent;
  style: ProposalImageStyle;
  position: ProposalElementPosition;
}

export interface ProposalTextOverlayImageElementModel {
  id: string;
  type: 'textOverlayImage';
  content: ProposalTextOverlayImageContent;
  style: ProposalTextOverlayImageStyle;
  position: ProposalElementPosition;
}

export interface ProposalBackgroundImageTextElementModel {
  id: string;
  type: 'backgroundImageText';
  content: ProposalBackgroundImageTextContent;
  style: ProposalBackgroundImageTextStyle;
  position: ProposalElementPosition;
}

export type ProposalSlideElement =
  | ProposalTextElementModel
  | ProposalVideoElementModel
  | ProposalImageElementModel
  | ProposalTextOverlayImageElementModel
  | ProposalBackgroundImageTextElementModel;

/** One slide in deck order; matches API JSON shape expected by backends. */
export interface ProposalSlide {
  id: string;
  /** Logical sort key (must stay stable across edits; backend often uses number). */
  index: number;
  title?: string;
  elements: ProposalSlideElement[];
  /** Presentation frame (px) — previews match export aspect when set. */
  frame?: { width: number; height: number };
}

export interface ProposalDocument {
  id: string;
  title: string;
  slides: ProposalSlide[];
  updatedAt?: string;
}

let idCounter = 0;
export function newProposalLocalId(prefix = 'el'): string {
  idCounter++;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

export function sortedByZ(elements: ProposalSlideElement[]): ProposalSlideElement[] {
  return [...elements].sort((a, b) => a.position.zIndex - b.position.zIndex);
}
