import { describe, expect, it } from 'vitest';
import { IMAGE_FILE_ACCEPT, describeUnsupportedImage } from './imageFormat';

const file = (name: string, type: string) => new File(['x'], name, { type });

describe('describeUnsupportedImage', () => {
  it('says nothing about the formats that work', () => {
    expect(describeUnsupportedImage(file('play.jpg', 'image/jpeg'))).toBeNull();
    expect(describeUnsupportedImage(file('play.png', 'image/png'))).toBeNull();
    expect(describeUnsupportedImage(file('play.webp', 'image/webp'))).toBeNull();
  });

  it('names an iPhone photo as an iPhone photo, and offers the fix that works', () => {
    const msg = describeUnsupportedImage(file('IMG_0042.HEIC', 'image/heic'));
    expect(msg).toContain('iPhone photo');
    expect(msg).toContain('Take a new photo');
  });

  it('recognises HEIC from the FILENAME when the browser gives no type', () => {
    // Some pickers hand over an empty type; the extension is all there is.
    expect(describeUnsupportedImage(file('IMG_0042.heic', ''))).toContain('iPhone photo');
    expect(describeUnsupportedImage(file('clip.HEIF', ''))).toContain('iPhone photo');
  });

  it('NEVER puts a MIME type in front of a coach', () => {
    // The message this replaced read "That file is a image/heic."
    for (const f of [
      file('doc.pdf', 'application/pdf'),
      file('IMG.HEIC', 'image/heic'),
      file('mystery', ''),
      file('clip.gif', 'image/gif'),
    ]) {
      const msg = describeUnsupportedImage(f) ?? '';
      expect(msg).not.toMatch(/image\//);
      expect(msg).not.toMatch(/application\//);
      expect(msg).not.toMatch(/MIME/i);
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it('tells anyone with any other file what they can use instead', () => {
    const msg = describeUnsupportedImage(file('notes.pdf', 'application/pdf')) ?? '';
    expect(msg).toContain('JPEG');
    expect(msg).toContain('PNG');
    expect(msg).toContain('WebP');
  });

  it('asks the picker for images broadly, so a phone converts rather than greys out', () => {
    expect(IMAGE_FILE_ACCEPT).toBe('image/*');
  });
});
