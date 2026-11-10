// Reused from the supplied image-generator project. See provenance.json.
import sharp from "sharp";
export const PACK_SIZE = 1080;
// Preserve proportions and all product edges, including when a provider returns a non-square image.
export async function normalizePackImage(image) {
    return sharp(image).rotate().resize(PACK_SIZE, PACK_SIZE, { fit: "contain", background: "#151515" })
        .flatten({ background: "#151515" }).toColourspace("srgb").png().toBuffer();
}
// Remove the example's 5 Pcs lettering from AI conditioning. The unchanged reference
// stays available in the UI; product identity always comes from the user's upload.
export async function preparePackReference(image) {
    const normalized = await normalizePackImage(image);
    // Both supplied references have empty dark background here. Reuse its texture
    // with feathered edges so the model does not copy a flat rectangular mask.
    const width = 428;
    const height = 226;
    const texture = await sharp(normalized).extract({ left: 32, top: 10, width: 480, height: 180 })
        .resize(width, height).removeAlpha().raw().toBuffer();
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = y * width + x;
            texture.copy(rgba, pixel * 4, pixel * 3, pixel * 3 + 3);
            rgba[pixel * 4 + 3] = Math.round(255 * Math.min(1, Math.min(x, y, width - x - 1, height - y - 1) / 18));
        }
    }
    return sharp(normalized).composite([{ input: rgba, raw: { width, height, channels: 4 }, left: 576, top: 78 }])
        .jpeg({ quality: 88 }).toBuffer();
}
export function parsePackReview(text) {
    let value;
    try {
        value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    }
    catch {
        throw new Error("The pack quantity review could not be read. Please retry this view.");
    }
    if (!value || typeof value !== "object")
        throw new Error("The pack quantity review was incomplete.");
    const review = value;
    if (!Number.isInteger(review.visiblePieceCount) || review.visiblePieceCount < -1 ||
        [review.matchesProduct, review.allPiecesVisible, review.badgeAreaClear].some((check) => typeof check !== "boolean") ||
        !Array.isArray(review.issues) || review.issues.some((issue) => typeof issue !== "string")) {
        throw new Error("The pack quantity review was incomplete. Please retry this view.");
    }
    return review;
}
export async function generateReviewedPack(options) {
    let previous;
    let correction = "";
    for (let attempt = 0; attempt < 2; attempt++) {
        const rendered = await options.render(correction, previous);
        const review = await options.review(rendered);
        const defects = [];
        if (review.visiblePieceCount !== options.quantity)
            defects.push(`Show exactly ${options.quantity} separate whole product units; the review counted ${review.visiblePieceCount < 0 ? "an unclear number" : review.visiblePieceCount}. Spread the units so each can be counted.`);
        if (!review.matchesProduct)
            defects.push("Restore the uploaded product's shape, material, colors and hardware; do not copy the reference product.");
        if (!review.allPiecesVisible)
            defects.push("Keep every complete unit inside the frame with readable outlines; use less overlap.");
        if (!review.badgeAreaClear)
            defects.push("Keep natural background clear in the top-right area (x55–93%, y8–28%) for an optional later tag. Remove lettering, badges and label placeholders.");
        if (!defects.length)
            return rendered;
        correction = [...defects, ...review.issues].join(" ").slice(0, 1500);
        previous = rendered;
    }
    throw new Error(`This view needs a clearer ${options.quantity}-piece arrangement. ${correction}`);
}
