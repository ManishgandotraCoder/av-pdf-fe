import { Injectable } from '@angular/core';

export type StoredPdfMeta = {
  id: string;
  name: string;
  size: number;
  createdAt: number;
  updatedAt: number;
};

export type StoredPdf = StoredPdfMeta & {
  bytes: Uint8Array;
};

const DB_NAME = 'avyro-editor';
const DB_VERSION = 1;
const STORE = 'pdfs';

type PdfRecord = StoredPdfMeta & { bytes: ArrayBuffer };

function toUint8(bytes: ArrayBuffer) {
  return new Uint8Array(bytes);
}

function uid() {
  // good-enough local id, no dependency
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

@Injectable({ providedIn: 'root' })
export class PdfStoreService {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB.'));
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
    });

    return this.dbPromise;
  }

  async list(): Promise<StoredPdfMeta[]> {
    const db = await this.openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onerror = () => reject(req.error ?? new Error('Failed to list PDFs.'));
      req.onsuccess = () => {
        const rows = (req.result as PdfRecord[]).map(({ bytes: _bytes, ...meta }) => meta);
        rows.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(rows);
      };
    });
  }

  async get(id: string): Promise<StoredPdf | null> {
    const db = await this.openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.get(id);
      req.onerror = () => reject(req.error ?? new Error('Failed to load PDF.'));
      req.onsuccess = () => {
        const row = (req.result as PdfRecord | undefined) ?? undefined;
        if (!row) return resolve(null);
        resolve({ ...row, bytes: toUint8(row.bytes) });
      };
    });
  }

  async putNew(fileName: string, bytes: Uint8Array): Promise<StoredPdfMeta> {
    const db = await this.openDb();
    const now = Date.now();
    const meta: StoredPdfMeta = {
      id: uid(),
      name: fileName,
      size: bytes.byteLength,
      createdAt: now,
      updatedAt: now
    };

    // Ensure ArrayBuffer (not SharedArrayBuffer) for IndexedDB + TS.
    const safeBytes = new Uint8Array(bytes.byteLength);
    safeBytes.set(bytes);
    const record: PdfRecord = { ...meta, bytes: safeBytes.buffer };

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.onerror = () => reject(tx.error ?? new Error('Failed to save PDF.'));
      tx.oncomplete = () => resolve();
      tx.objectStore(STORE).put(record);
    });

    return meta;
  }

  async delete(id: string): Promise<void> {
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.onerror = () => reject(tx.error ?? new Error('Failed to delete PDF.'));
      tx.oncomplete = () => resolve();
      tx.objectStore(STORE).delete(id);
    });
  }
}

