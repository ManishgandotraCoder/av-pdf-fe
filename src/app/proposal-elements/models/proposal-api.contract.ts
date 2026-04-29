/**
 * HTTP contract for persistence of proposal decks (slides + elements).
 *
 * Servers may extend meta fields; breaking changes require version negotiation.
 */

import type {
  ProposalDocument,
  ProposalSlide,
  ProposalSlideElement
} from './proposal-element.model';

export interface ApiErrorBody {
  error: string;
  code?: string;
  details?: unknown;
}

/** `POST /api/proposals`, `PUT /api/proposals/:id` */
export interface CreateUpdateProposalBody {
  title: string;
  slides: ProposalSlidePayload[];
}

export interface ProposalSlidePayload {
  id?: string;
  index: number;
  title?: string;
  elements: ProposalSlideElement[];
  frame?: { width: number; height: number };
}

export interface ProposalResponse extends ProposalDocument {
  createdAt?: string;
}

/** `POST /api/proposals/:proposalId/slides` */
export interface CreateSlideBody {
  index: number;
  title?: string;
  cloneFromSlideId?: string;
}

export interface ProposalSlidePatchBody {
  index?: number;
  title?: string;
  /** Full replace — partial element merge is not implied. */
  elements?: ProposalSlideElement[];
}

/** Element CRUD for slides */
export interface AddElementBody {
  element: ProposalSlideElement;
}

export interface PatchElementBody {
  id: string;
  /** Deep partial over element fields the server supports merging. */
  patch: Partial<ProposalSlideElement>;
}

export interface UploadMediaSuccess {
  assetId: string;
  /** Short-lived PUT URL pattern or CDN GET URL depending on backend. */
  url: string;
  mimeType?: string;
  thumbUrl?: string;
}
