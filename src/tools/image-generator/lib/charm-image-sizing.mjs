// Reused from the supplied image-generator project. See provenance.json.
import sharp from "sharp";
// The model may return a different canvas ratio. Pad instead of stretching the
// phone, hand, camera lenses or charm to the requested export dimensions.
export function fitCharmImage(image, width, height, background = { r: 0, g: 0, b: 0, alpha: 0 }) {
    return sharp(image)
        .rotate()
        .ensureAlpha()
        .resize(width, height, { fit: "contain", position: "centre", background, kernel: sharp.kernel.lanczos3 })
        .toColourspace("srgb");
}
