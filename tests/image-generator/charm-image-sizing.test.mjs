import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { fitCharmImage } from "../../src/tools/image-generator/lib/charm-image-sizing.mjs";

async function solidImage(width, height) {
  return sharp({ create: { width, height, channels: 4, background: { r: 230, g: 40, b: 40, alpha: 1 } } }).png().toBuffer();
}

function subjectBounds(data, info) {
  let left = info.width, top = info.height, right = -1, bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      if (data[offset] > 200 && data[offset + 1] < 80 && data[offset + 2] < 80) {
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

test("portrait and landscape model responses retain proportions in square transparent exports", async () => {
  for (const [width, height] of [[200, 400], [400, 200], [300, 300]]) {
    const { data, info } = await fitCharmImage(await solidImage(width, height), 1080, 1080).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 1080); assert.equal(info.height, 1080);
    const bounds = subjectBounds(data, info);
    assert.equal(bounds.width / bounds.height, width / height);
    if (width !== height) assert.equal(data[3], 0, "padded corners must remain transparent");
  }
});

test("chroma padding and opaque flatlay exports preserve product geometry", async () => {
  const { data, info } = await fitCharmImage(await solidImage(200, 400), 1080, 1080, "#00FF00")
    .flatten({ background: "#00FF00" }).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...data.subarray(0, 3)], [0, 255, 0]);
  const bounds = subjectBounds(data, info);
  assert.equal(bounds.height / bounds.width, 2);
  const flatlay = await fitCharmImage(await solidImage(400, 400), 900, 1200, "#FFFFFF")
    .flatten({ background: "#FFFFFF" }).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(subjectBounds(flatlay.data, flatlay.info), { left: 0, top: 150, width: 900, height: 900 });
  assert.deepEqual([...flatlay.data.subarray(0, 3)], [255, 255, 255]);
});

test("EXIF orientation is applied before proportional sizing", async () => {
  const rotated = await sharp(await solidImage(200, 400)).withMetadata({ orientation: 6 }).png().toBuffer();
  const { data, info } = await fitCharmImage(rotated, 1080, 1080).raw().toBuffer({ resolveWithObject: true });
  const bounds = subjectBounds(data, info);
  assert.equal(bounds.width / bounds.height, 2);
});
