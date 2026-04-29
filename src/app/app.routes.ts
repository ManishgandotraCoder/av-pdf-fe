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
    path: 'proposal-elements',
    loadComponent: () =>
      import('./proposal-elements/proposal-elements-demo.component').then(
        (m) => m.ProposalElementsDemoComponent
      )
  },
  {
    path: '**',
    redirectTo: ''
  }
];
