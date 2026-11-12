import { describe, expect, it } from 'vitest';
import type { ImageLimits } from '../../../shared/agents/agents.rpc';
import { admitImages, imageSize, type Candidate } from './images';

const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, ...u16be(n)];
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

const pngBytes = (width: number, height: number): Uint8Array =>
  new Uint8Array([
    0x89,
    ...ascii('PNG\r\n'),
    0x1a,
    0x0a,
    ...u32be(13),
    ...ascii('IHDR'),
    ...u32be(width),
    ...u32be(height),
    8,
    6,
    0,
    0,
    0,
  ]);

const gifBytes = (width: number, height: number) =>
  new Uint8Array([...ascii('GIF89a'), ...u16le(width), ...u16le(height), 0, 0, 0]);

const jpegBytes = (width: number, height: number) =>
  new Uint8Array([
    0xff,
    0xd8,
    // APP0, 16 bytes long
    0xff,
    0xe0,
    ...u16be(16),
    ...ascii('JFIF'),
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    // SOF2 (progressive)
    0xff,
    0xc2,
    ...u16be(17),
    8,
    ...u16be(height),
    ...u16be(width),
    3,
  ]);

const webpVp8xBytes = (width: number, height: number) =>
  new Uint8Array([
    ...ascii('RIFF'),
    0,
    0,
    0,
    0,
    ...ascii('WEBP'),
    ...ascii('VP8X'),
    ...[10, 0, 0, 0],
    0,
    0,
    0,
    0,
    ...u24le(width - 1),
    ...u24le(height - 1),
  ]);

const limits: ImageLimits = { maxBase64Bytes: 100, maxDimensionPx: 50, maxPerMessage: 2 };

const image = (overrides: Partial<Candidate> = {}): Candidate => ({
  name: 'shot.png',
  mimeType: 'image/png',
  data: 'AAAA',
  size: { width: 10, height: 10 },
  ...overrides,
});

describe('imageSize', () => {
  it('reads the size of PNG, GIF, JPEG and WebP images', () => {
    expect(imageSize(pngBytes(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSize(gifBytes(32, 16))).toEqual({ width: 32, height: 16 });
    expect(imageSize(jpegBytes(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(imageSize(webpVp8xBytes(9000, 3))).toEqual({ width: 9000, height: 3 });
  });

  it('reads no size from bytes that are not an image', () => {
    expect(imageSize(new Uint8Array(ascii('hello, this is text')))).toBeNull();
  });
});

describe('admitImages', () => {
  it('takes images within the limits', () => {
    const result = admitImages(0, [image()], { limits, canAttach: true });
    expect(result).toEqual({
      accepted: [{ name: 'shot.png', mimeType: 'image/png', data: 'AAAA' }],
      refusals: [],
    });
  });

  it('refuses anything that is not a PNG, JPEG, GIF or WebP image', () => {
    const result = admitImages(
      0,
      [image({ name: 'notes.txt', mimeType: 'text/plain', size: null }), image({ size: null })],
      { limits, canAttach: true },
    );
    expect(result.accepted).toEqual([]);
    expect(result.refusals).toEqual([{ kind: 'notImage' }, { kind: 'notImage' }]);
  });

  it('refuses, never resizes, an image over the size or side limit', () => {
    const result = admitImages(
      0,
      [
        image({ name: 'big.png', data: 'A'.repeat(104) }),
        image({ name: 'wide.png', size: { width: 51, height: 1 } }),
      ],
      { limits, canAttach: true },
    );
    expect(result.accepted).toEqual([]);
    expect(result.refusals).toEqual([
      { kind: 'tooLarge', name: 'big.png', maxBase64Bytes: 100 },
      { kind: 'tooWide', name: 'wide.png', maxDimensionPx: 50 },
    ]);
  });

  it('refuses the images past the count a Message can hold', () => {
    const result = admitImages(1, [image({ name: 'a.png' }), image({ name: 'b.png' })], {
      limits,
      canAttach: true,
    });
    expect(result.accepted.map((accepted) => accepted.name)).toEqual(['a.png']);
    expect(result.refusals).toEqual([{ kind: 'tooMany', maxPerMessage: 2 }]);
  });

  it("refuses every image when the Agent can't take images", () => {
    const result = admitImages(0, [image()], { limits, canAttach: false });
    expect(result).toEqual({ accepted: [], refusals: [{ kind: 'cantTake' }] });
  });
});
