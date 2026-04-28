import { Injectable } from '@angular/core';

export type PdfMeta = {
  id: string;
  name: string;
  size: number;
  createdAt: number;
  updatedAt: number;
};

@Injectable({ providedIn: 'root' })
export class PdfApiService {
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
    const res = await fetch('/api/pdfs');
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Failed to load library.';
      throw new Error(msg);
    }
    return (await res.json()) as PdfMeta[];
  }

  async upload(file: File): Promise<PdfMeta> {
    const fd = new FormData();
    fd.set('file', file);
    const res = await fetch('/api/pdfs', { method: 'POST', body: fd });
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Upload failed.';
      throw new Error(msg);
    }
    return (await res.json()) as PdfMeta;
  }

  async getMeta(id: string): Promise<PdfMeta> {
    const res = await fetch(`/api/pdfs/${encodeURIComponent(id)}/meta`);
    if (!res.ok) throw new Error('Failed to load PDF meta.');
    return (await res.json()) as PdfMeta;
  }

  async getBytes(id: string): Promise<Uint8Array> {
    const res = await fetch(`/api/pdfs/${encodeURIComponent(id)}`);
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
    const res = await fetch(`/api/pdfs/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body
    });
    if (!res.ok) {
      const msg = (await this.readErrorMessage(res)) ?? 'Failed to save PDF.';
      throw new Error(msg);
    }
    return (await res.json()) as PdfMeta;
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(`/api/pdfs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete PDF.');
  }
}

