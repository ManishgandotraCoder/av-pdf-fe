import { Injectable } from '@angular/core';

export type AssetMeta = {
  isTemplate?: boolean;
  tags?: string[];
  /** Display name override (optional) */
  templateName?: string;
  updatedAt?: number;
};

const LS_KEY = 'avyro-asset-meta:v1';

function readAll(): Record<string, AssetMeta> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as Record<string, AssetMeta>;
  } catch {
    return {};
  }
}

function writeAll(next: Record<string, AssetMeta>) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {
    // ignore (private mode / quota / disabled storage)
  }
}

function normalizeTags(input: string): string[] {
  const parts = input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // de-dupe (case-insensitive) while keeping first casing
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

@Injectable({ providedIn: 'root' })
export class AssetMetaService {
  get(id: string): AssetMeta | null {
    const all = readAll();
    return all[id] ?? null;
  }

  isTemplate(id: string): boolean {
    return Boolean(this.get(id)?.isTemplate);
  }

  tags(id: string): string[] {
    return this.get(id)?.tags ?? [];
  }

  setTemplateMeta(id: string, meta: { templateName: string; tagsCsv: string }) {
    const all = readAll();
    const prev = all[id] ?? {};
    const next: AssetMeta = {
      ...prev,
      isTemplate: true,
      templateName: meta.templateName.trim(),
      tags: normalizeTags(meta.tagsCsv),
      updatedAt: Date.now()
    };
    all[id] = next;
    writeAll(all);
  }
}

