import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImageLightbox } from './ImageLightbox';

// See QuestionInput.test.tsx for why AnnotationViewer (a real Fabric.js
// StaticCanvas) is stubbed rather than mounted in jsdom.
vi.mock('./annotation/AnnotationViewer', () => ({
  AnnotationViewer: (props: { imageUrl: string; annotations: unknown[]; alt: string }) => (
    <div
      data-testid="annotation-viewer"
      data-image-url={props.imageUrl}
      data-annotation-count={props.annotations.length}
    >
      {props.alt}
    </div>
  ),
}));

describe('ImageLightbox', () => {
  it('renders the image at the given src/alt', () => {
    render(<ImageLightbox src="/photo.png" alt="Film still, enlarged" onClose={vi.fn()} />);
    const img = screen.getByAltText('Film still, enlarged') as HTMLImageElement;
    expect(img.src).toContain('/photo.png');
  });

  it('closes on backdrop click', () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="/photo.png" alt="Film still" onClose={onClose} />);
    // Not .parentElement - PinchZoomPan wraps the image in its own surface/content divs, so the
    // true backdrop is a couple of levels further up than the image's immediate parent.
    const backdrop = screen.getByAltText('Film still').closest('[class*="backdrop"]');
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when clicking the image itself', () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="/photo.png" alt="Film still" onClose={onClose} />);
    fireEvent.click(screen.getByAltText('Film still'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="/photo.png" alt="Film still" onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes via the close button', () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="/photo.png" alt="Film still" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking PinchZoomPan\'s reset-zoom button does not also close the lightbox', () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="/photo.png" alt="Film still" onClose={onClose} />);
    const surface = screen.getByAltText('Film still').closest('[class*="surface"]')!;
    fireEvent.doubleClick(surface, { clientX: 50, clientY: 50 });

    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders the annotation viewer instead of a plain image when annotations are given', () => {
    render(
      <ImageLightbox
        src="/photo.png"
        alt="Film still, enlarged"
        onClose={vi.fn()}
        annotations={[{ id: 'a1', type: 'line' }]}
        canvasWidth={1400}
      />,
    );
    expect(screen.queryByAltText('Film still, enlarged')).not.toBeInTheDocument();
    const viewer = screen.getByTestId('annotation-viewer');
    expect(viewer.dataset.annotationCount).toBe('1');
    expect(viewer.dataset.imageUrl).toBe('/photo.png');
  });

  it('renders a plain image when annotations is an empty array', () => {
    render(
      <ImageLightbox src="/photo.png" alt="Film still, enlarged" onClose={vi.fn()} annotations={[]} />,
    );
    expect(screen.getByAltText('Film still, enlarged')).toBeInTheDocument();
    expect(screen.queryByTestId('annotation-viewer')).not.toBeInTheDocument();
  });
});
