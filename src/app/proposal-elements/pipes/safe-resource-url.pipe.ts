import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

/** Maps known embed URLs onto trusted iframe src bindings. */
@Pipe({ name: 'safeVideoUrl', standalone: true })
export class SafeVideoUrlPipe implements PipeTransform {
  private readonly sanitizer = inject(DomSanitizer);

  transform(url: string): SafeResourceUrl {
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }
}
