import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { PdfApiService, type PdfMeta } from '../pdf-api/pdf-api.service';

@Component({
  selector: 'app-pdf-library',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './pdf-library.component.html',
  styleUrl: './pdf-library.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PdfLibraryComponent {
  private readonly api = inject(PdfApiService);
  private readonly router = inject(Router);

  protected readonly isLoading = signal(false);
  protected readonly errorText = signal<string | null>(null);
  protected readonly items = signal<PdfMeta[]>([]);

  protected readonly hasItems = computed(() => this.items().length > 0);

  constructor() {
    void this.refresh();
  }

  protected async refresh() {
    this.errorText.set(null);
    this.isLoading.set(true);
    try {
      this.items.set(await this.api.list());
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Failed to load library.');
    } finally {
      this.isLoading.set(false);
    }
  }

  protected async onPickFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    if (!file) return;

    this.errorText.set(null);
    this.isLoading.set(true);

    try {
      const meta = await this.api.upload(file);
      await this.refresh();
      await this.router.navigate(['/edit', meta.id]);
    } catch (e) {
      this.errorText.set(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      this.isLoading.set(false);
      input.value = '';
    }
  }

  protected open(item: PdfMeta) {
    void this.router.navigate(['/edit', item.id]);
  }

  protected async delete(item: PdfMeta) {
    if (!confirm(`Delete "${item.name}" from the server?`)) return;
    this.isLoading.set(true);
    try {
      await this.api.delete(item.id);
      await this.refresh();
    } finally {
      this.isLoading.set(false);
    }
  }

  protected formatSize(bytes: number) {
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    return `${(kb / 1024).toFixed(1)} MB`;
  }

  protected formatDate(ts: number) {
    return new Date(ts).toLocaleString();
  }
}

