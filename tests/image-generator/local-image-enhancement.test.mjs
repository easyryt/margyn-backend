import assert from "node:assert/strict";
import test from "node:test";
import { enhancePixels, enhancementSize, enhanceLocalImage } from "../../src/tools/image-generator/lib/local-image-enhancement.mjs";

const options = { detail: 40, lighting: false, scale: 1 };
test("enhancement is non-mutating, preserves alpha and is identity at zero detail", () => {
  const pixels = new Uint8ClampedArray([20, 80, 160, 0, 100, 110, 120, 128, 230, 220, 210, 255]);
  const original = new Uint8ClampedArray(pixels);
  assert.deepEqual(enhancePixels(pixels, 3, 1, { ...options, detail: 0 }), original);
  const result = enhancePixels(pixels, 3, 1, { ...options, detail: 100, lighting: true });
  assert.deepEqual(pixels, original);
  assert.deepEqual([result[3], result[7], result[11]], [0, 128, 255]);
  assert.deepEqual(result.slice(0, 4), original.slice(0, 4));
});

test("uniform tones, white highlights and transparent hidden colors do not produce halos", () => {
  const pixels = new Uint8ClampedArray([255, 0, 255, 0, 100, 110, 120, 255, 100, 110, 120, 255]);
  assert.deepEqual(enhancePixels(pixels, 3, 1, options), pixels);
  for (const shade of [0, 255]) {
    const plain = new Uint8ClampedArray([shade, shade, shade, 255]);
    assert.deepEqual(enhancePixels(plain, 1, 1, { ...options, lighting: true }), plain);
  }
});

test("detail remains bounded while optional shadow lift is gentle", () => {
  const pixels = new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255, 255, 255, 255, 255]);
  const result = enhancePixels(pixels, 3, 1, { ...options, detail: 100 });
  for (let index = 0; index < pixels.length; index += 4) assert.ok(Math.abs(result[index] - pixels[index]) <= 12);
  const dark = new Uint8ClampedArray([60, 60, 60, 255]);
  const lifted = enhancePixels(dark, 1, 1, { ...options, lighting: true });
  assert.ok(lifted[0] > 60 && lifted[0] < 69);
});

test("export dimensions preserve portrait, landscape and square proportions within rounding", () => {
  assert.deepEqual(enhancementSize(1080, 1080, 2), { width: 2160, height: 2160 });
  assert.deepEqual(enhancementSize(1080, 1080, 1), { width: 1080, height: 1080 });
  assert.deepEqual(enhancementSize(1200, 1600, 2), { width: 1620, height: 2160 });
  assert.deepEqual(enhancementSize(4000, 3000, 1), { width: 2160, height: 1620 });
  for (const [width, height] of [[123, 456], [1723, 888], [1, 1]]) {
    const output = enhancementSize(width, height, 2);
    assert.ok(Math.max(output.width, output.height) <= 2160);
    assert.ok(Math.abs(output.width / width - output.height / height) < .02);
  }
});

test("invalid data, oversized decoded images and remote sources fail without network requests", async () => {
  assert.throws(() => enhancementSize(5000, 5000, 1), /16 megapixels/);
  assert.throws(() => enhancementSize(0, 3, 1), /dimensions/);
  assert.throws(() => enhancementSize(3, 3, 4), /2×/);
  assert.throws(() => enhancePixels(new Uint8ClampedArray(1), 3, 3, options), /RGBA/);
  assert.throws(() => enhancePixels(new Uint8ClampedArray(4), 1, 1, { ...options, detail: NaN }), /Detail/);
  await assert.rejects(enhanceLocalImage("https://example.com/image.png", options), /local/);
  await assert.rejects(enhanceLocalImage("data:image/svg+xml;base64,PHN2Zz4=", options), /local/);
});
