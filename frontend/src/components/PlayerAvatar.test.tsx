import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PlayerAvatar } from './PlayerAvatar';

describe('PlayerAvatar', () => {
  it('renders an image when a photo URL is present', () => {
    const { container } = render(<PlayerAvatar name="Jordan Smith" photoUrl="/uploads/abc123.jpg" />);

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', expect.stringContaining('/uploads/abc123.jpg'));
  });

  it('shows initials when there is no photo', () => {
    const { container } = render(<PlayerAvatar name="Jordan Smith" photoUrl={null} />);

    expect(screen.getByText('JS')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('falls back to initials when the image fails to load', () => {
    const { container } = render(<PlayerAvatar name="Jordan Smith" photoUrl="/uploads/broken.jpg" />);

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    fireEvent.error(img!);

    expect(screen.getByText('JS')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('uses a single initial for a one-word name', () => {
    render(<PlayerAvatar name="Prince" photoUrl={null} />);
    expect(screen.getByText('P')).toBeInTheDocument();
  });
});
