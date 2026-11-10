// Reused from the supplied image-generator project. See provenance.json.
import sharp from "sharp";
const FALLBACK = "Use only the uploaded case's exact artwork, motif positions, colors, transparent material and printed wording. Do not copy or combine any previous template artwork.";
export const COVER_IDENTITY_SCHEMA = {
    type: "object", additionalProperties: false,
    properties: {
        designSummary: { type: "string" },
        visibleText: { type: "array", items: { type: "string" } },
        productBounds: { type: ["array", "null"], items: { type: "number", minimum: 0, maximum: 1000 }, minItems: 4, maxItems: 4 },
        surfaceQuad: { type: ["array", "null"], description: "Four outer back-plane corners [x,y], in product top-left, top-right, bottom-right, bottom-left order; 0-1000 image coordinates. Null if cropped, hidden or uncertain.", items: { type: "array", items: { type: "number", minimum: 0, maximum: 1000 }, minItems: 2, maxItems: 2 }, minItems: 4, maxItems: 4 },
        lowerArtwork: { type: "string", description: "Concise visible bottom-third artwork and intentional clear space, including whether motifs reach the bottom bumper. Do not invent missing detail." },
        backMaterial: { type: "string", enum: ["clear", "opaque", "unknown"], description: "clear only for visibly colorless transparent back material; opaque for solid/colored/white/black backs; unknown if uncertain. A gray surface seen THROUGH a clear case is photographic backing, not gray case ink." },
    }, required: ["designSummary", "visibleText", "productBounds", "surfaceQuad", "lowerArtwork", "backMaterial"],
};
export const COVER_REVIEW_SCHEMA = {
    type: "object", additionalProperties: false,
    properties: {
        designMatches: { type: ["boolean", "null"], description: "true: visible artwork matches; false: a concrete visible mismatch; null: cannot judge" },
        cameraMatches: { type: ["boolean", "null"], description: "true: visible camera hardware matches; false: clearly wrong; null: too small or occluded to judge" },
        fitMatches: { type: ["boolean", "null"], description: "true: solid phone fills snug case down to bottom bumper; false: smaller phone in oversized case or see-through empty extension; null: cannot judge" },
        edgeArtworkMatches: { type: ["boolean", "null"], description: "true: visible lower-edge print/clear spacing agrees with raw; false: source motifs replaced by invented blank white footer; null: occluded or cannot judge" },
        compositionMatches: { type: ["boolean", "null"], description: "true: coherent phone/hand; false: duplicate fingers, double phone edge, blank wedge or clipped product label; null: cannot judge" },
        issues: { type: "array", items: { type: "string" }, maxItems: 2 },
    }, required: ["designMatches", "cameraMatches", "fitMatches", "edgeArtworkMatches", "compositionMatches", "issues"],
};
function parseSurfaceQuad(value) {
    if (!Array.isArray(value) || value.length !== 4 || !value.every((point) => Array.isArray(point) && point.length === 2 && point.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1000)))
        return null;
    const points = value;
    // Reject tiny, concave, crossed or collapsed surfaces before local projection.
    let area = 0, sign = 0;
    for (let i = 0; i < 4; i++) {
        const a = points[i], b = points[(i + 1) % 4], c = points[(i + 2) % 4];
        const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if (cross < 1000 || (sign && Math.sign(cross) !== sign) || Math.hypot(b[0] - a[0], b[1] - a[1]) < 80)
            return null;
        sign = Math.sign(cross);
        area += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(area) / 2 >= 30_000 ? points : null;
}
export function parseCoverIdentity(text) {
    try {
        const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
        const brief = typeof value?.designSummary === "string" ? value.designSummary.trim().slice(0, 1600) : FALLBACK;
        const visibleText = Array.isArray(value?.visibleText) ? value.visibleText.filter((item) => typeof item === "string").map((item) => item.slice(0, 120)).slice(0, 12) : [];
        const b = value?.productBounds;
        let bounds = Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1000) && b[2] - b[0] >= 150 && b[3] - b[1] >= 150 ? b : null;
        const surfaceQuad = parseSurfaceQuad(value?.surfaceQuad);
        if (surfaceQuad) {
            const xs = surfaceQuad.map((p) => p[0]), ys = surfaceQuad.map((p) => p[1]);
            // A narrower analysis box must never crop the real bottom artwork.
            bounds = [Math.min(bounds?.[0] ?? 1000, ...ys), Math.min(bounds?.[1] ?? 1000, ...xs), Math.max(bounds?.[2] ?? 0, ...ys), Math.max(bounds?.[3] ?? 0, ...xs)];
        }
        return { brief: brief || FALLBACK, visibleText, bounds, surfaceQuad, lowerArtwork: typeof value?.lowerArtwork === "string" ? value.lowerArtwork.trim().slice(0, 400) : "", backMaterial: value?.backMaterial === "clear" || value?.backMaterial === "opaque" ? value.backMaterial : "unknown" };
    }
    catch {
        // A truncated JSON object is not an artwork description.
        const plain = text.trim();
        return { brief: plain && !/^[{\[`]/.test(plain) ? plain.slice(0, 1600) : FALLBACK, visibleText: [], bounds: null, surfaceQuad: null, lowerArtwork: "", backMaterial: "unknown" };
    }
}
export function assessCoverReview(review) {
    const checks = [review.designMatches, review.cameraMatches, review.fitMatches, review.edgeArtworkMatches, review.compositionMatches];
    const status = checks.includes(false) ? "mismatch" : checks.every((check) => check === true) && !review.issues.length ? "passed" : "needs-review";
    const issues = [...review.issues];
    if (review.designMatches === false)
        issues.unshift("The AI reviewer flagged an artwork mismatch. Compare the draft with your raw upload.");
    if (review.cameraMatches === false)
        issues.unshift("The AI reviewer flagged different camera hardware. Inspect the lens count and arrangement.");
    if (review.fitMatches === false)
        issues.unshift("The AI reviewer flagged a phone/case size mismatch or empty case extension. Inspect the bottom bumper and side edges before using this draft.");
    if (review.edgeArtworkMatches === false)
        issues.unshift("The AI reviewer flagged missing lower-edge artwork or an invented white footer. Compare the visible bottom pattern with your raw upload.");
    if (review.compositionMatches === false)
        issues.unshift("The AI reviewer flagged an alignment, hand or label-cropping defect. Do not publish without inspecting it.");
    if (checks.includes(null))
        issues.push("Some details were too small, unclear or occluded for the AI check. Inspect them yourself.");
    return { ...review, status, issues };
}
export async function cropCoverReference(image, bounds) {
    if (!bounds)
        return image;
    const metadata = await sharp(image).metadata();
    const width = metadata.width, height = metadata.height;
    const [top, left, bottom, right] = bounds;
    // Add generous outer-edge padding: the label and bumper must not be clipped.
    const padX = (right - left) * .06, padY = (bottom - top) * .06;
    const x = Math.max(0, Math.floor((left - padX) * width / 1000));
    const y = Math.max(0, Math.floor((top - padY) * height / 1000));
    const endX = Math.min(width, Math.ceil((right + padX) * width / 1000));
    const endY = Math.min(height, Math.ceil((bottom + padY) * height / 1000));
    return sharp(image).extract({ left: x, top: y, width: endX - x, height: endY - y }).png().toBuffer();
}
export function parseCoverReview(text) {
    let value;
    try {
        value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    }
    catch {
        throw new Error("The artwork/camera check returned unreadable JSON; the image remains unverified.");
    }
    if (!value || ![true, false, null].includes(value.designMatches) || ![true, false, null].includes(value.cameraMatches) || ![true, false, null].includes(value.fitMatches) || ![true, false, null].includes(value.edgeArtworkMatches) || ![true, false, null].includes(value.compositionMatches) || !Array.isArray(value.issues) || value.issues.some((issue) => typeof issue !== "string")) {
        throw new Error("The artwork/camera check was incomplete; the image remains unverified.");
    }
    return { designMatches: value.designMatches, cameraMatches: value.cameraMatches, fitMatches: value.fitMatches, edgeArtworkMatches: value.edgeArtworkMatches, compositionMatches: value.compositionMatches, issues: value.issues.slice(0, 4).map((issue) => issue.slice(0, 200)) };
}
