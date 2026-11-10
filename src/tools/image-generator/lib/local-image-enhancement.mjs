// Reused from the supplied image-generator project. See provenance.json.
export const DEFAULT_ENHANCEMENT = { detail: 40, lighting: false, scale: 1 };
const MAX_INPUT_PIXELS = 16_000_000;
const MAX_OUTPUT_EDGE = 2160;
function validateDimensions(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_INPUT_PIXELS) {
        throw new Error("Use an image of at most 16 megapixels with valid dimensions.");
    }
}
export function enhancementSize(width, height, scale) {
    validateDimensions(width, height);
    if (scale !== 1 && scale !== 2)
        throw new Error("Choose original size or 2× size.");
    const factor = Math.min(scale, MAX_OUTPUT_EDGE / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) };
}
/** Gentle, bounded retouching. Transparent pixels never contribute to edge detail. */
export function enhancePixels(input, width, height, options) {
    validateDimensions(width, height);
    if (input.length !== width * height * 4)
        throw new Error("Invalid RGBA image data.");
    if (!Number.isFinite(options.detail) || options.detail < 0 || options.detail > 100)
        throw new Error("Detail must be between 0 and 100.");
    const output = new Uint8ClampedArray(input);
    const amount = options.detail / 100;
    if (!amount && !options.lighting)
        return output;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = (y * width + x) * 4;
            if (!input[index + 3])
                continue;
            let red = 0, green = 0, blue = 0, total = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = Math.max(0, Math.min(width - 1, x + dx));
                    const ny = Math.max(0, Math.min(height - 1, y + dy));
                    const neighbor = (ny * width + nx) * 4;
                    const weight = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1) * input[neighbor + 3] / 255;
                    red += input[neighbor] * weight;
                    green += input[neighbor + 1] * weight;
                    blue += input[neighbor + 2] * weight;
                    total += weight;
                }
            }
            const luminance = input[index] * .2126 + input[index + 1] * .7152 + input[index + 2] * .0722;
            const blurred = (red * .2126 + green * .7152 + blue * .0722) / total;
            const difference = luminance - blurred;
            // Suppress tiny variations, sharpen meaningful edges without strong halos.
            const detail = Math.abs(difference) < 2 ? -difference * .15 * amount : Math.max(-12, Math.min(12, difference * .65 * amount));
            const tone = options.lighting ? 9 * Math.sin(Math.PI * luminance / 255) * (1 - luminance / 255) : 0;
            const adjustment = (detail + tone) * input[index + 3] / 255;
            for (let channel = 0; channel < 3; channel++)
                output[index + channel] = input[index + channel] + adjustment;
        }
    }
    return output;
}
export async function enhanceLocalImage(source, options) {
    // Only local uploads or already-generated images; never fetch a remote image or model.
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(source) && !source.startsWith("blob:")) {
        throw new Error("Choose a local JPG, PNG or WebP image.");
    }
    const image = new window.Image();
    const loaded = new Promise((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("This image could not be decoded."));
    });
    image.src = source;
    await loaded;
    const width = image.naturalWidth, height = image.naturalHeight;
    const size = enhancementSize(width, height, options.scale);
    // Process at native resolution before enlargement; cap large uploads to export bounds.
    const baseFactor = Math.min(1, MAX_OUTPUT_EDGE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * baseFactor));
    canvas.height = Math.max(1, Math.round(height * baseFactor));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context)
        throw new Error("Your browser does not support image enhancement.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    // Let the working indicator paint before CPU-based retouching.
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    pixels.data.set(enhancePixels(pixels.data, canvas.width, canvas.height, options));
    context.putImageData(pixels, 0, 0);
    const output = document.createElement("canvas");
    output.width = size.width;
    output.height = size.height;
    const target = output.getContext("2d");
    if (!target)
        throw new Error("Could not create the enhanced download.");
    target.imageSmoothingEnabled = true;
    target.imageSmoothingQuality = "high";
    target.drawImage(canvas, 0, 0, size.width, size.height);
    const dataUrl = output.toDataURL("image/png");
    // Release canvas backing stores; the PNG is the only retained enhanced copy.
    canvas.width = canvas.height = output.width = output.height = 1;
    return { dataUrl, ...size };
}
