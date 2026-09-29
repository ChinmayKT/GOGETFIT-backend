import test from 'node:test';
import assert from 'node:assert/strict';

import { assertValidImage, detectImageType } from '../../src/utils/image.js';

const jpeg = (extra = 32) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(extra)]);
const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32),
  ]);
const webp = () =>
  Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('WEBP', 'ascii'),
    Buffer.alloc(32),
  ]);

test('real image types are detected from their magic bytes', () => {
  assert.equal(detectImageType(jpeg()).extension, 'jpg');
  assert.equal(detectImageType(png()).extension, 'png');
  assert.equal(detectImageType(webp()).extension, 'webp');
});

test('a non-image payload is rejected however it is labelled', () => {
  // An ELF binary and a shell script, both of which a client could claim is a
  // .jpg with an image/jpeg content type.
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)]);
  const script = Buffer.from('#!/bin/sh\nrm -rf /\n', 'utf8');

  assert.equal(detectImageType(elf), null);
  assert.equal(detectImageType(script), null);
  assert.throws(() => assertValidImage(elf, { maxBytes: 1024 }), /Unsupported image/);
  assert.throws(() => assertValidImage(script, { maxBytes: 1024 }), /Unsupported image/);
});

test('an empty upload is rejected', () => {
  assert.throws(() => assertValidImage(Buffer.alloc(0), { maxBytes: 1024 }), /No image data/);
  assert.throws(() => assertValidImage(undefined, { maxBytes: 1024 }), /No image data/);
});

test('an oversized image is rejected with a size error', () => {
  const big = jpeg(2048);
  assert.throws(
    () => assertValidImage(big, { maxBytes: 512 }),
    (error) => error.code === 'FILE_TOO_LARGE',
  );
});

test('a valid image returns its sniffed type', () => {
  const type = assertValidImage(png(), { maxBytes: 1024 * 1024 });
  assert.equal(type.extension, 'png');
  assert.equal(type.mimeType, 'image/png');
});

test('an image renamed to a different extension is judged by its bytes', () => {
  // PNG bytes that a client called "avatar.jpg" - it is stored as .png.
  assert.equal(assertValidImage(png(), { maxBytes: 1024 }).extension, 'png');
});
