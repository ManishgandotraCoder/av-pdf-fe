import { Injectable } from '@angular/core';

export type PdfMeta = {
  id: string;
  name: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  parentId?: string;
  isOriginal?: boolean;
};

export type ProposalVersion = {
  id: string;
  proposalId: string;
  versionName: string;
  createdAt: number;
  createdBy: string;
};

export type ClearProposalVersionsResult = {
  ok: boolean;
  rootId: string;
  deletedIds: string[];
};

export type ProposalDetails = {
  id: string;
  name: string;
  derivedFrom: string | null;
  rejection?: ProposalRejection | null;
  derivedFromDetails?: {
    id: string;
    name: string;
    isDeleted?: boolean;
    hasAccess?: boolean;
  } | null;
};

export type RejectionLevel = 'internal' | 'client';

export type ProposalRejection = {
  proposalId: string;
  level: RejectionLevel;
  reason: string;
  rejectedBy: string;
  rejectedAt: number;
};

export type ShareAccessType = 'public' | 'restricted';
export type ShareRole = 'viewer' | 'commenter' | 'editor';

export type ShareUser = {
  email: string;
  role: ShareRole;
};

export type ShareRecord = {
  id: string;
  proposalId: string;
  accessType: ShareAccessType;
  users: ShareUser[];
  linkToken: string;
  createdAt: number;
  updatedAt: number;
  sharedBy?: string;
  derivedFrom?: {
    id: string;
    name: string;
  } | null;
};

export type GenerateShareLinkBody = {
  proposalId: string;
  accessType: ShareAccessType;
  sharedBy?: string;
  derivedFrom?: {
    id: string;
    name: string;
  } | null;
  /** Origin for absolute share URLs (e.g. https://app.example.com). */
  linkBaseUrl?: string;
};

export type RejectProposalBody = {
  level: RejectionLevel;
  reason?: string;
  rejectedBy?: string;
};

export type AddShareUserBody = {
  proposalId: string;
  email: string;
  role: ShareRole;
};

/** Categories returned by GET /api/crm/asset-library (proxied from CRM when configured). */
export type CrmAssetLibraryCategory = { id: string; name: string };

/** Normalized row for the editor Assets Library panel. */
export type CrmAssetLibraryItem = {
  id: string;
  name: string;
  kind: 'image' | 'video' | 'template' | 'other';
  categoryId?: string;
  url?: string;
  previewUrl?: string;
  mimeType?: string;
};

export type CrmAssetLibraryResponse = {
  crmConfigured: boolean;
  categories: CrmAssetLibraryCategory[];
  assets: CrmAssetLibraryItem[];
};

export type PageFurniture = {
  proposalTitle: string;
  clientName: string;
  header: { content: string; alignment: 'left' | 'center' | 'right'; visible: boolean };
  footer: {
    leftContent: string;
    centerContent: string;
    rightContent: string;
    visible: boolean;
    divider: boolean;
  };
  pageNumber: {
    visible: boolean;
    format: '1' | '1 / N' | 'Page 1 of N';
    position: 'header-left' | 'header-right' | 'footer-left' | 'footer-center' | 'footer-right';
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

const PROD_BACKEND_ORIGIN = 'https://av-pdf-be.vercel.app';
const LOCAL_BACKEND_ORIGIN = 'http://localhost:5050';

function resolveBackendOrigin(): string {
  // If the frontend is being served locally, hit the local backend.
  // Covers common local hosts (localhost + loopback IP).
  if (typeof window !== 'undefined') {
    const host = window.location?.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return LOCAL_BACKEND_ORIGIN;
  }
  return PROD_BACKEND_ORIGIN;
}

const BACKEND_ORIGIN = resolveBackendOrigin();

@Injectable({ providedIn: 'root' })
export class PdfApiService {
  private apiUrl(pathname: string): string {
    const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
    // Keep `/api/...` paths stable across environments.
    return `${BACKEND_ORIGIN}${path}`;
  }

  private looksLikeHtml(text: string): boolean {
    const t = text.trimStart().slice(0, 400).toLowerCase();
    if (t.startsWith('<!doctype') || t.startsWith('<html') || t.startsWith('<head')) return true;
    if (t.startsWith('<!--') && t.includes('<html')) return true;
    return t.startsWith('<') && /<\s*(html|body|head|div|title)\b/i.test(t);
  }

  private truncateDetail(s: string, max = 220): string {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length <= max ? t : `${t.slice(0, max)}…`;
  }

  /** Best-effort message from a failed API response body (never returns raw HTML). */
  private parseErrorFromBody(text: string, status: number): string | null {
    if (this.looksLikeHtml(text)) {
      if (status === 413 || status === 431) {
        return 'The proposal is too large for the server (HTTP 413). Try a smaller file or raise the API upload limit.';
      }
      if (status === 404) {
        return 'API returned “not found” (HTTP 404). Check that the backend is running and /api is proxied correctly.';
      }
      if (status === 502 || status === 503 || status === 504) {
        return `Server is temporarily unavailable (HTTP ${status}). Retry shortly.`;
      }
      return `The server returned an HTML page (HTTP ${status}) instead of a JSON error. Check the API URL, proxy, and deployment.`;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return status ? `Request failed (HTTP ${status}).` : null;
    }

    try {
      const j = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
      const e = j?.error ?? j?.message;
      if (typeof e === 'string' && e.length > 0) return e;
    } catch {
      // not JSON
    }

    return this.truncateDetail(trimmed);
  }

  private parseJsonBody<T>(text: string, context: string): T {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error(`Empty response from server (${context}).`);
    }
    if (this.looksLikeHtml(trimmed)) {
      throw new Error(
        `Invalid response (${context}): received HTML instead of JSON. Confirm the API base URL and /api proxy.`
      );
    }
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      throw new Error(`Invalid response (${context}): body is not valid JSON.`);
    }
  }

  private async readJsonResponse<T>(res: Response, context: string, fallbackError: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      const msg = this.parseErrorFromBody(text, res.status) ?? fallbackError;
      throw new Error(msg);
    }
    return this.parseJsonBody<T>(text, context);
  }

  private async readErrorMessage(res: Response): Promise<string | null> {
    try {
      const text = await res.text();
      return this.parseErrorFromBody(text, res.status);
    } catch {
      return null;
    }
  }

  private assertPdfBytes(bytes: Uint8Array) {
    if (bytes.byteLength < 5) {
      throw new Error('Empty PDF (no bytes).');
    }
    const a = new Uint8Array(5);
    a.set(bytes.subarray(0, 5));
    const head = new TextDecoder('utf-8').decode(a);
    if (head !== '%PDF-') {
      // Often happens when the server returns HTML/JSON and we try to parse it as PDF.
      if (a[0] === 0x3c) {
        // '<'
        throw new Error('Received HTML instead of a PDF. Check the dev server proxy to /api.');
      }
      throw new Error('Not a valid PDF (missing %PDF- header).');
    }
  }

  async list(): Promise<PdfMeta[]> {
    const res = await fetch(this.apiUrl('/api/pdfs'));
    return this.readJsonResponse<PdfMeta[]>(res, 'list PDFs', 'Failed to load library.');
  }

  async upload(file: File): Promise<PdfMeta> {
    const fd = new FormData();
    fd.set('file', file);
    const res = await fetch(this.apiUrl('/api/pdfs'), { method: 'POST', body: fd });
    return this.readJsonResponse<PdfMeta>(res, 'upload PDF', 'Upload failed.');
  }

  async getMeta(id: string): Promise<PdfMeta> {
    const res = await fetch(this.apiUrl(`/api/pdfs/${encodeURIComponent(id)}/meta`));
    return this.readJsonResponse<PdfMeta>(res, 'PDF meta', 'Failed to load PDF meta.');
  }

  async getBytes(id: string): Promise<Uint8Array> {
    const res = await fetch(this.apiUrl(`/api/pdfs/${encodeURIComponent(id)}`));
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Failed to load PDF.';
      throw new Error(msg);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    this.assertPdfBytes(buf);
    return buf;
  }

  async saveBytes(id: string, bytes: Uint8Array): Promise<PdfMeta> {
    // Some TS DOM libs in Angular builds don't include Uint8Array/ArrayBufferLike as BodyInit,
    // so send a Blob.
    const safe = new Uint8Array(bytes.byteLength);
    safe.set(bytes);
    const body = new Blob([safe.buffer], { type: 'application/pdf' });
    const res = await fetch(this.apiUrl(`/api/pdfs/${encodeURIComponent(id)}`), {
      method: 'PUT',
      body
    });
    return this.readJsonResponse<PdfMeta>(res, 'save PDF', 'Failed to save PDF.');
  }

  async saveAsNewProposal(
    sourceProposalId: string,
    bytes: Uint8Array,
    options?: { name?: string; editedBy?: string }
  ): Promise<PdfMeta & { versionId: string; timestamp: number; editedBy: string; parentProposalId: string }> {
    const safe = new Uint8Array(bytes.byteLength);
    safe.set(bytes);
    const blob = new Blob([safe.buffer], { type: 'application/pdf' });
    const fd = new FormData();
    fd.set('file', new File([blob], options?.name ?? 'proposal.pdf', { type: 'application/pdf' }));
    fd.set('sourceProposalId', sourceProposalId);
    if (options?.name) fd.set('name', options.name);
    if (options?.editedBy) fd.set('editedBy', options.editedBy);

    const res = await fetch(this.apiUrl('/api/proposals/save-as-new'), {
      method: 'POST',
      body: fd
    });
    return this.readJsonResponse<
      PdfMeta & {
        versionId: string;
        timestamp: number;
        editedBy: string;
        parentProposalId: string;
      }
    >(res, 'save new proposal version', 'Failed to save new proposal version.');
  }

  async overwriteProposal(id: string, bytes: Uint8Array, editedBy?: string): Promise<PdfMeta> {
    const safe = new Uint8Array(bytes.byteLength);
    safe.set(bytes);
    const body = new Blob([safe.buffer], { type: 'application/pdf' });
    const res = await fetch(this.apiUrl(`/api/proposals/overwrite/${encodeURIComponent(id)}`), {
      method: 'POST',
      headers: editedBy ? { 'X-Edited-By': editedBy } : undefined,
      body
    });
    return this.readJsonResponse<PdfMeta>(res, 'overwrite proposal', 'Failed to overwrite proposal.');
  }

  async getProposalVersions(id: string): Promise<ProposalVersion[]> {
    const res = await fetch(this.apiUrl(`/api/proposals/${encodeURIComponent(id)}/versions`));
    return this.readJsonResponse<ProposalVersion[]>(res, 'proposal versions', 'Failed to load proposal versions.');
  }

  /**
   * Deletes all derived proposal PDFs for this document chain (keeps the root upload).
   * Editor should clear local overlay state and navigate to `rootId`.
   */
  async clearProposalVersions(id: string): Promise<ClearProposalVersionsResult> {
    const res = await fetch(this.apiUrl(`/api/proposals/${encodeURIComponent(id)}/clear-versions`), {
      method: 'POST'
    });
    return this.readJsonResponse<ClearProposalVersionsResult>(
      res,
      'clear proposal versions',
      'Failed to clear saved versions.'
    );
  }

  async getProposal(id: string): Promise<ProposalDetails> {
    const res = await fetch(this.apiUrl(`/api/proposal/${encodeURIComponent(id)}`));
    return this.readJsonResponse<ProposalDetails>(res, 'proposal details', 'Failed to load proposal.');
  }

  async generateShareLink(body: GenerateShareLinkBody): Promise<ShareRecord & { url: string }> {
    const payload: GenerateShareLinkBody = {
      ...body,
      ...(typeof window !== 'undefined' && window.location?.origin
        ? { linkBaseUrl: window.location.origin }
        : {})
    };
    const res = await fetch(this.apiUrl('/api/share/generate-link'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return this.readJsonResponse<ShareRecord & { url: string }>(res, 'share link', 'Failed to generate share link.');
  }

  async getShareForProposal(proposalId: string): Promise<ShareRecord | null> {
    const res = await fetch(this.apiUrl(`/api/share/by-proposal/${encodeURIComponent(proposalId)}`));
    return this.readJsonResponse<ShareRecord | null>(res, 'share settings', 'Failed to load share settings.');
  }

  async addShareUser(body: AddShareUserBody): Promise<ShareRecord> {
    const res = await fetch(this.apiUrl('/api/share/add-user'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return this.readJsonResponse<ShareRecord>(res, 'add share user', 'Failed to add share user.');
  }

  async rejectProposal(id: string, body: RejectProposalBody): Promise<ProposalRejection> {
    const res = await fetch(this.apiUrl(`/api/proposals/${encodeURIComponent(id)}/reject`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return this.readJsonResponse<ProposalRejection>(res, 'reject proposal', 'Failed to reject proposal.');
  }

  async getProposalRejection(id: string): Promise<ProposalRejection | null> {
    const res = await fetch(this.apiUrl(`/api/proposals/${encodeURIComponent(id)}/rejection`));
    const text = await res.text();
    if (res.status === 404) return null;
    if (!res.ok) {
      const msg = this.parseErrorFromBody(text, res.status) ?? 'Failed to load rejection status.';
      throw new Error(msg);
    }
    return this.parseJsonBody<ProposalRejection>(text, 'rejection status');
  }

  async restoreProposalVersion(
    id: string,
    versionId: string,
    editedBy?: string
  ): Promise<PdfMeta & { restoredFromVersionId: string }> {
    const res = await fetch(
      this.apiUrl(`/api/proposals/${encodeURIComponent(id)}/restore-version/${encodeURIComponent(versionId)}`),
      {
        method: 'POST',
        headers: editedBy ? { 'Content-Type': 'application/json' } : undefined,
        body: editedBy ? JSON.stringify({ editedBy }) : undefined
      }
    );
    return this.readJsonResponse<PdfMeta & { restoredFromVersionId: string }>(
      res,
      'restore proposal version',
      'Failed to restore proposal version.'
    );
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(this.apiUrl(`/api/pdfs/${encodeURIComponent(id)}`), { method: 'DELETE' });
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Failed to delete PDF.';
      throw new Error(msg);
    }
  }

  async getFurniture(id: string): Promise<PageFurniture | null> {
    const res = await fetch(this.apiUrl(`/api/pdfs/${encodeURIComponent(id)}/furniture`));
    const text = await res.text();
    if (res.status === 404) return null;
    if (!res.ok) {
      const msg = this.parseErrorFromBody(text, res.status) ?? 'Failed to load page furniture.';
      throw new Error(msg);
    }
    const payload = this.parseJsonBody<{ pageFurniture?: PageFurniture | null }>(text, 'page furniture');
    return payload?.pageFurniture ?? null;
  }

  async putFurniture(id: string, furniture: PageFurniture): Promise<void> {
    const res = await fetch(this.apiUrl(`/api/pdfs/${encodeURIComponent(id)}/furniture`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageFurniture: furniture })
    });
    const text = await res.text();
    if (!res.ok) {
      const msg = this.parseErrorFromBody(text, res.status) ?? 'Failed to save page furniture.';
      throw new Error(msg);
    }
  }

  /** Loads CRM-backed asset library metadata (empty when CRM is not configured on the backend). */
  async getCrmAssetLibrary(): Promise<CrmAssetLibraryResponse> {
    const res = await fetch(this.apiUrl('/api/crm/asset-library'));
    return this.readJsonResponse<CrmAssetLibraryResponse>(res, 'asset library', 'Failed to load asset library.');
  }
}

