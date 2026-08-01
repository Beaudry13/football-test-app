import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImageLightbox } from './ImageLightbox';

describe('ImageLightbox', () => {
  it('renders the image at the given src/alt', () => {
    render(<ImageLightbox src="/photo.png" alt="Film still, enlarged" onClose={vi.fn()} />);
    const img = screen.getByAltText('Film still, enlarged') as HTMLImageElement;
    expect(img.src).toContain('/photo.png');
  });

  it('closes on backdrop click', () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="/photo.png" alt="Film still" onClose={onClose} />);
    fireEvent.click(screen.getByAltText('Film still').parentElement!);
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
});
