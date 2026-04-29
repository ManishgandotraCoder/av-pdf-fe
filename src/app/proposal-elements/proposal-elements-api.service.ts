import { Injectable } from '@angular/core';

import type { ProposalSlide, ProposalSlideElement } from './models/proposal-element.model';

const PROD_BACKEND_ORIGIN = 'https://av-pdf-be.vercel.app';
const LOCAL_BACKEND_ORIGIN = 'http://localhost:5050';

function resolveBackendOrigin(): string {
  if (typeof window !== 'undefined') {
    const host = window.location?.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return LOCAL_BACKEND_ORIGIN;
  }
  return PROD_BACKEND_ORIGIN;
}

@Injectable({ providedIn: 'root' })
export class ProposalElementsApiService {
  private readonly base = resolveBackendOrigin();

  private apiUrl(pathname: string): string {
    const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
    return `${this.base}${path}`;
  }

  async getSlide(id: string): Promise<ProposalSlide> {
    const res = await fetch(this.apiUrl(`/api/slides/${encodeURIComponent(id)}`));
    if (!res.ok) throw new Error('Failed to load slide.');
    return (await res.json()) as ProposalSlide;
  }

  async addElement(slideId: string, element: ProposalSlideElement): Promise<ProposalSlide> {
    const res = await fetch(this.apiUrl(`/api/slides/${encodeURIComponent(slideId)}/elements`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ element })
    });
    if (!res.ok) throw new Error('Failed to add element.');
    return (await res.json()) as ProposalSlide;
  }

  async patchElement(elementId: string, patch: Partial<ProposalSlideElement>): Promise<ProposalSlide> {
    const res = await fetch(this.apiUrl(`/api/elements/${encodeURIComponent(elementId)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch })
    });
    if (!res.ok) throw new Error('Failed to update element.');
    return (await res.json()) as ProposalSlide;
  }

  async deleteElement(elementId: string): Promise<ProposalSlide> {
    const res = await fetch(this.apiUrl(`/api/elements/${encodeURIComponent(elementId)}`), {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error('Failed to delete element.');
    return (await res.json()) as ProposalSlide;
  }
}
