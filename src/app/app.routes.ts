import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pdf-library/pdf-library.component').then((m) => m.PdfLibraryComponent)
  },
  {
    path: 'edit/:id',
    loadComponent: () =>
      import('./pdf-editor/pdf-editor.component').then((m) => m.PdfEditorComponent)
  },
  {
    path: '**',
    redirectTo: ''
  }
];
