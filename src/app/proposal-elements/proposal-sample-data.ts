import type { ProposalSlide } from './models/proposal-element.model';
import { newProposalLocalId } from './models/proposal-element.model';

export function createSampleProposalSlide(): ProposalSlide {
  return {
    id: 'slide_demo_1',
    index: 0,
    title: 'Sample proposal slide',
    frame: { width: 920, height: 520 },
    elements: [
      {
        id: newProposalLocalId('txt'),
        type: 'text',
        content: {
          html: '<p><strong>Proposal</strong> — native element model (new text pipeline).</p><p>Existing PDF widget text is unchanged.</p>'
        },
        style: {
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          fontSizePx: 16,
          color: '#18181b',
          lineHeight: 1.45,
          paddingPx: 8
        },
        position: { x: 40, y: 30, width: 360, height: 160, zIndex: 2 }
      },
      {
        id: newProposalLocalId('vid'),
        type: 'video',
        content: {
          videoSourceMode: 'embed',
          embedUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
          sourceUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
          thumbnailUrl: 'https://picsum.photos/seed/vidthumb/640/360'
        },
        style: { objectFit: 'contain' },
        position: { x: 410, y: 30, width: 460, height: 240, zIndex: 3 }
      },
      {
        id: newProposalLocalId('img'),
        type: 'image',
        content: {
          imageSourceMode: 'link',
          src: 'https://picsum.photos/seed/proposalimg/400/300',
          alt: 'Sample'
        },
        style: { borderRadiusPx: 10, boxShadow: '0 8px 24px rgb(15 23 42 / 18%)' },
        position: { x: 40, y: 210, width: 220, height: 180, zIndex: 2 }
      },
      {
        id: newProposalLocalId('toi'),
        type: 'textOverlayImage',
        content: {
          imageSrc: 'https://picsum.photos/seed/overlay/800/500',
          overlayHtml: '<h2>Text over image</h2><p>Mask + alignment</p>',
          overlayPosition: { preset: 'bottom' }
        },
        style: {
          overlayMaskOpacity: 0.5,
          overlayMaskTone: 'dark',
          contentPaddingPx: 16,
          textAlign: 'left'
        },
        position: { x: 270, y: 210, width: 320, height: 180, zIndex: 4 }
      },
      {
        id: newProposalLocalId('bit'),
        type: 'backgroundImageText',
        content: {
          imageSrc: 'https://picsum.photos/seed/fullbleed/1200/800',
          overlayHtml: '<h2>Background + text</h2><p>Cover / contain, tint, max width.</p>'
        },
        style: {
          backgroundSize: 'cover',
          overlayOpacity: 0.45,
          overlayColor: '#0f172a',
          innerPaddingPx: 20,
          textMaxWidthPx: 420
        },
        position: { x: 40, y: 360, width: 830, height: 140, zIndex: 1 }
      }
    ]
  };
}
