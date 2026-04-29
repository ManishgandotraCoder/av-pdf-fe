/**
 * Public barrel for the slide-based proposal element system.
 * Does not export PDF editor internals.
 */

export type * from './models/proposal-element.model';
export type * from './models/proposal-api.contract';

export { createSampleProposalSlide } from './proposal-sample-data';
export { typographyCssFromStyle } from './element-renderer/element-renderer.component';

export { ElementRendererComponent } from './element-renderer/element-renderer.component';
export { ProposalElementShellComponent } from './proposal-element-shell/proposal-element-shell.component';
export { ProposalSlideStageComponent } from './proposal-slide-stage/proposal-slide-stage.component';
export { ProposalElementsDemoComponent } from './proposal-elements-demo.component';
export { ProposalElementsApiService } from './proposal-elements-api.service';

export { TextBlockComponent } from './text-block/text-block.component';
export { VideoBlockComponent } from './video-block/video-block.component';
export { ImageBlockComponent } from './image-block/image-block.component';
export { TextOverlayImageBlockComponent } from './text-overlay-image-block/text-overlay-image-block.component';
export { BackgroundImageTextBlockComponent } from './background-image-text-block/background-image-text-block.component';
