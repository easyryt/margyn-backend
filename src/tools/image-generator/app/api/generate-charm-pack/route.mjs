// Reused from the supplied image-generator project. See provenance.json.
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { AiRequestError, createAiClientFromForm, getParts } from "../../../lib/ai-provider.mjs";
import { PACK_VIEWS, isPackViewId, parsePackQuantity } from "../../../lib/charm-pack-options.mjs";
import { generateReviewedPack, normalizePackImage, parsePackReview, preparePackReference } from "../../../lib/charm-pack-generation.mjs";
export const runtime = "nodejs";
export const maxDuration = 300;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
async function generateView(ai, product, quantity, view, reference) {
    const scene = view.id === "pack-fan"
        ? "A natural hand holding a neatly fanned group between fingertips against a softly lit black leather surface. Show separate product outlines and natural reflections."
        : "A natural open palm presenting the products against a clean deep black background. Spread products across the palm with separate readable outlines and soft studio light.";
    const parts = [
        { text: `Create one premium square ecommerce product photograph of EXACTLY ${quantity} identical whole units of the uploaded product. IMAGE 1 is the only source of product identity. IMAGE 2 is a STYLE reference only, with its old badge covered. Match its photography mood, not its product design, color or count.
Preserve the upload's silhouette, proportions, translucency, color, eyelet/clasp metal color and all visible features. If the upload is small, keep its simple geometry; do not invent decoration, branding, hardware or texture. Silver stays silver; never substitute gold from the example. Remove the raw photo's backdrop, dirt and uneven exposure. Make the material smooth and professional with realistic reflections, crisp edges and natural shadows.
SCENE: ${scene}
QUANTITY: exactly ${quantity} complete units, individually countable. A unit is the entire uploaded product, not each ring or component. ${quantity > 5 ? "Use two or more clearly separated staggered rows/fans as needed for this larger pack; avoid a dense stack." : "Use a spacious single fan with light overlap."} Keep every unit within the frame with comfortable margins. Adapt the hand framing naturally to the pack size.
Return an untagged photograph. Keep the top-right area x55–93%, y8–28% naturally clear of products and fingers so the user can optionally add a quantity tag AFTER generation. Continue the same natural background texture through this area: no visible rectangle, patch or placeholder. No text, numbers, badge, watermark, border, collage or additional props anywhere. Output only the photograph.
PRODUCT DETAILS: ${product.brief}` },
        { text: "IMAGE 1: uploaded single product — reproduce this exact product" },
        { inlineData: { mimeType: "image/png", data: product.data } },
        { text: "IMAGE 2: scene and lighting reference only — ignore its product color, quantity and masked badge area" },
        { inlineData: { mimeType: "image/jpeg", data: reference.toString("base64") } },
    ];
    const clean = await generateReviewedPack({
        quantity,
        render: async (correction, previous) => {
            const repair = previous ? [
                { text: "PREVIOUS ATTEMPT: repair this arrangement using the original uploaded product." },
                { inlineData: { mimeType: "image/png", data: previous.toString("base64") } },
                { text: `CORRECTION: ${correction} Keep exactly ${quantity} visible whole units. Leave natural background clear in the top-right area for an optional later tag. No lettering, badge or label placeholder.` },
            ] : [];
            const payload = await ai.request("image", {
                contents: [{ role: "user", parts: [...parts, ...repair] }],
                generationConfig: { responseModalities: ["IMAGE"], responseFormat: { image: { aspectRatio: "ASPECT_RATIO_ONE_BY_ONE" } } },
            });
            const image = getParts(payload).find((part) => part.inlineData?.data || part.inline_data?.data);
            const data = image?.inlineData?.data || image?.inline_data?.data;
            if (!data)
                throw new Error(`${ai.label} did not return ${view.label.toLowerCase()}. Please retry this view.`);
            return normalizePackImage(Buffer.from(data, "base64"));
        },
        review: async (image) => {
            const payload = await ai.request("text", {
                contents: [{ role: "user", parts: [
                            { text: `Inspect IMAGE 1 (single uploaded product) and IMAGE 2 (generated pack photo WITHOUT a quantity label). Count actual whole product units in IMAGE 2, not rings, decorations, fingers or text. Expected quantity is ${quantity}; report what is actually visible, never assume the expected count is present. Use -1 if overlap makes counting impossible.
Return only JSON: {"visiblePieceCount": integer, "matchesProduct": boolean, "allPiecesVisible": boolean, "badgeAreaClear": boolean, "issues": string[]}.
matchesProduct: same product shape, material, color and metal finish as IMAGE 1, allowing improved lighting and a different pose. allPiecesVisible: all units inside the frame and separately readable; slight overlap is allowed. badgeAreaClear: natural background only in rectangle x55–93%, y8–28% with no products, fingers, badge or label placeholder. There must be no added lettering anywhere; the user may add a tag later. Accept either a fan or staggered rows and any natural hand pose. Issues should briefly describe only actual defects and how to fix them. Do not enforce the style reference's five-piece count or gold eyelets.` },
                            { inlineData: { mimeType: "image/png", data: product.data } },
                            { inlineData: { mimeType: "image/png", data: image.toString("base64") } },
                        ] }],
                generationConfig: { temperature: 0, responseModalities: ["TEXT"], maxOutputTokens: 600 },
            });
            return parsePackReview(getParts(payload).map((part) => part.text || "").join("\n"));
        },
    });
    // Always return the untouched, reviewed original. Optional tags are drawn locally in the browser.
    return { id: `${Date.now()}-${view.id}`, templateId: view.id, label: view.label, quantity, showQuantity: false,
        dataUrl: `data:image/png;base64,${clean.toString("base64")}`, mimeType: "image/png" };
}
export async function POST(request) {
    try {
        const form = await request.formData();
        const quantity = parsePackQuantity(form.get("quantity"));
        if (quantity === null)
            throw new AiRequestError("Choose a whole number of pieces from 1 to 20.", 400);
        const tagOption = form.get("showQuantity");
        if (tagOption !== null && tagOption !== "true" && tagOption !== "false")
            throw new AiRequestError("Choose whether to show the quantity tag (true or false).", 400);
        // Accept the old field for cached clients, but never burn a tag into the original.
        const selected = form.get("view") ?? "all";
        if (selected !== "all" && !isPackViewId(selected))
            throw new AiRequestError("Choose a valid charm-pack view.", 400);
        const file = form.get("image");
        if (!(file instanceof File) || !file.size)
            throw new AiRequestError("Upload one raw photo of a single charm-pack product.", 400);
        if (!ALLOWED_TYPES.has(file.type))
            throw new AiRequestError("Use a JPG, PNG, or WebP image.", 415);
        if (file.size > 10 * 1024 * 1024)
            throw new AiRequestError("The raw image must be 10 MB or smaller.", 413);
        let raw;
        try {
            raw = await sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 40_000_000 })
                .rotate().resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
        }
        catch {
            throw new AiRequestError("This image could not be read. Upload a valid JPG, PNG, or WebP photo.", 415);
        }
        const ai = createAiClientFromForm(form);
        const active = PACK_VIEWS.filter((view) => selected === "all" || selected === view.id);
        const references = await Promise.all(active.map(async (view) => preparePackReference(await readFile(path.join(process.cwd(), "public", view.reference)))));
        await request.reserveImages?.(active.length);
        const data = raw.toString("base64");
        const analysis = await ai.request("text", {
            contents: [{ role: "user", parts: [
                        { text: "Describe only this single product's silhouette, material/transparency, proportions, colors and metal/hardware color in under 90 words. Ignore the background. Do not invent details or quantities. This identity will be repeated into a product pack." },
                        { inlineData: { mimeType: "image/png", data } },
                    ] }], generationConfig: { temperature: 0, responseModalities: ["TEXT"], maxOutputTokens: 300 },
        });
        const brief = getParts(analysis).map((part) => part.text || "").join("\n").slice(0, 1400);
        const settled = await Promise.allSettled(active.map((view, index) => generateView(ai, { data, brief }, quantity, view, references[index])));
        const images = [];
        const failures = [];
        settled.forEach((result, index) => {
            if (result.status === "fulfilled")
                images.push(result.value);
            else
                failures.push({ viewId: active[index].id, label: active[index].label, message: (result.reason instanceof Error ? result.reason.message : "This view could not be generated.").slice(0, 500) });
        });
        const providerFailure = settled.find((result) => result.status === "rejected" && result.reason instanceof AiRequestError);
        const status = images.length ? 200 : providerFailure?.status === "rejected" ? providerFailure.reason.status : 502;
        return Response.json({ images, failures, quantity, showQuantity: false, complete: !failures.length, provider: ai.provider,
            ...(!images.length ? { error: failures[0]?.message || "The pack could not be generated. Please retry." } : {}) }, { status, headers: { "Cache-Control": "no-store" } });
    }
    catch (error) {
        return Response.json({ error: (error instanceof Error ? error.message : "Charm-pack generation failed.").slice(0, 350) }, { status: error instanceof AiRequestError ? error.status : 500, headers: { "Cache-Control": "no-store" } });
    }
}
