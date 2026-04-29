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

  private async readErrorMessage(res: Response): Promise<string | null> {
    try {
      const text = await res.text();
      try {
        const j = JSON.parse(text) as { error?: unknown };
        const e = j?.error;
        if (typeof e === 'string' && e.length > 0) return e;
      } catch {
        // ignore
      }
      const t = text.trim();
      return t.length > 0 ? t : null;
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
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Failed to load library.';
      throw new Error(msg);
    }
    return (await res.json()) as PdfMeta[];
  }

  async upload(file: File): Promise<PdfMeta> {
    const fd = new FormData();
    fd.set('file', file);
    const res = await fetch(this.apiUrl('/api/pdfs'), { method: 'POST', body: fd });
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Upload failed.';
      throw new Error(msg);
    }
    return (await res.json()) as PdfMeta;
  }

  async getMeta(id: string): Promise<PdfMeta> {
    const res = await fetch(this.apiUrl(`/api/pdfs/${encodeURIComponent(id)}/meta`));
    if (!res.ok) throw new Error('Failed to load PDF meta.');
    return (await res.json()) as PdfMeta;
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
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Failed to save PDF.';
      throw new Error(msg);
    }
    return (await res.json()) as PdfMeta;
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
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Failed to save new proposal version.';
      throw new Error(msg);
    }
    return (await res.json()) as PdfMeta & {
      versionId: string;
      timestamp: number;
      editedBy: string;
      parentProposalId: string;
    };
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
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Failed to overwrite proposal.';
      throw new Error(msg);
    }
    return (await res.json()) as PdfMeta;
  }

  async getProposalVersions(id: string): Promise<ProposalVersion[]> {
    const res = await fetch(this.apiUrl(`/api/proposals/${encodeURIComponent(id)}/versions`));
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Failed to load proposal versions.';
      throw new Error(msg);
    }
    return (await res.json()) as ProposalVersion[];
  }

  async getProposal(id: string): Promise<ProposalDetails> {
    const res = await fetch(this.apiUrl(`/api/proposal/${encodeURIComponent(id)}`));
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Failed to load proposal.';
      throw new Error(msg);
    }
    return (await res.json()) as ProposalDetails;
  }

  async generateShareLink(body: GenerateShareLinkBody): Promise<ShareRecord & { url: string }> {
    const res = await fetch(this.apiUrl('/api/share/generate-link'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Failed to generate share link.';
      throw new Error(msg);
    }
    return (await res.json()) as ShareRecord & { url: string };
  }

  async addShareUser(body: AddShareUserBody): Promise<ShareRecord> {
    const res = await fetch(this.apiUrl('/api/share/add-user'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Failed to add share user.';
      throw new Error(msg);
    }
    return (await res.json()) as ShareRecord;
  }

  async rejectProposal(id: string, body: RejectProposalBody): Promise<ProposalRejection> {
    const res = await fetch(this.apiUrl(`/api/proposals/${encodeURIComponent(id)}/reject`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Failed to reject proposal.';
      throw new Error(msg);
    }
    return (await res.json()) as ProposalRejection;
  }

  async getProposalRejection(id: string): Promise<ProposalRejection | null> {
    const res = await fetch(this.apiUrl(`/api/proposals/${encodeURIComponent(id)}/rejection`));
    if (res.status === 404) return null;
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Failed to load rejection status.';
      throw new Error(msg);
    }
    return (await res.json()) as ProposalRejection;
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
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Failed to restore proposal version.';
      throw new Error(msg);
    }
    return (await res.json()) as PdfMeta & { restoredFromVersionId: string };
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(this.apiUrl(`/api/pdfs/${encodeURIComponent(id)}`), { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete PDF.');
  }

  async getFurniture(id: string): Promise<PageFurniture | null> {
    const res = await fetch(this.apiUrl(`/api/pdfs/${encodeURIComponent(id)}/furniture`));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Failed to load page furniture.');
    const payload = (await res.json()) as { pageFurniture?: PageFurniture | null };
    return payload?.pageFurniture ?? null;
  }

  async putFurniture(id: string, furniture: PageFurniture): Promise<void> {
    const res = await fetch(this.apiUrl(`/api/pdfs/${encodeURIComponent(id)}/furniture`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageFurniture: furniture })
    });
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Failed to save page furniture.';
      throw new Error(msg);
    }
  }
}

