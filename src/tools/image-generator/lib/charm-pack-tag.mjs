// Reused from the supplied image-generator project. See provenance.json.
import { PACK_MAX_PIECES, PACK_MIN_PIECES, packQuantityLabel } from "./charm-pack-options.mjs";
// Browser-only finishing: no SVG text or server-installed fonts are involved.
export function drawPackQuantityTag(context, width, height, quantity) {
    if (!Number.isInteger(quantity) || quantity < PACK_MIN_PIECES || quantity > PACK_MAX_PIECES)
        throw new Error("Invalid pack quantity.");
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
        throw new Error("Invalid image size.");
    context.save();
    try {
        context.scale(width / 1080, height / 1080);
        context.fillStyle = "#f4f4f4";
        context.beginPath();
        context.roundRect(596, 98, 388, 186, 34);
        context.fill();
        context.fillStyle = "#f00000";
        context.font = `700 ${quantity < 10 ? 100 : 88}px Arial, Helvetica, sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(packQuantityLabel(quantity), 790, 191, 344);
    }
    finally {
        context.restore();
    }
}
export async function createTaggedPackImage(originalDataUrl, quantity) {
    // Only decode the already-generated local image. Tag edits never call an AI API.
    if (!originalDataUrl.startsWith("data:image/png;base64,"))
        throw new Error("The original PNG is unavailable. Generate this view again.");
    const original = new window.Image();
    await new Promise((resolve, reject) => {
        original.onload = () => resolve();
        original.onerror = () => reject(new Error("The image could not be loaded. Please try adding the tag again."));
        original.src = originalDataUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = original.naturalWidth;
    canvas.height = original.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context)
        throw new Error("Your browser could not create the tag. You can still download the original image.");
    context.drawImage(original, 0, 0);
    drawPackQuantityTag(context, canvas.width, canvas.height, quantity);
    return canvas.toDataURL("image/png");
}
