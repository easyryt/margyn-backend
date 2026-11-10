// Reused from the supplied image-generator project. See provenance.json.
import sharp from "sharp";
import { CHARM_ATTACHMENT_INSTRUCTION, FLATLAY_COMPOSITION_INSTRUCTION, generateReviewedHand, HAND_COMPOSITION_INSTRUCTION, HAND_COMPOSITION_REVIEW_PROMPT, parseHandCompositionReview, } from "../../../lib/charm-hand-composition.mjs";
import { fitCharmImage } from "../../../lib/charm-image-sizing.mjs";
import { AiRequestError, createAiClientFromForm, getParts, isFatalAiError } from "../../../lib/ai-provider.mjs";
import { isCharmViewId } from "../../../lib/charm-view-options.mjs";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const OUTPUT_SIZE = 1080;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const CHARM_LAYOUTS = [
    { id: "hand-closeup", label: "Hand, cover & charm", transparent: true,
        aspectRatio: "ASPECT_RATIO_ONE_BY_ONE", output: { width: 1080, height: 1080 }, instruction: HAND_COMPOSITION_INSTRUCTION },
    { id: "charm-product-flatlay", label: "Cover & charm product view", transparent: false,
        aspectRatio: "ASPECT_RATIO_THREE_BY_FOUR", output: { width: 900, height: 1200 }, instruction: FLATLAY_COMPOSITION_INSTRUCTION },
    { id: "charm-only", label: "Charm product view", transparent: false,
        aspectRatio: "ASPECT_RATIO_ONE_BY_ONE", output: { width: 1080, height: 1080 },
        instruction: "Create a fresh clean catalog photograph of the uploaded charm only. Preserve its complete structure, focal pieces, components, materials and colors. Improve photography, exposure and reflections without redesigning the product. Arrange the entire charm on white with a gentle contact shadow. The raw photo is a product reference, not a background or pose to copy. Include no phone, hand, extra charm, props or text." },
];
const SHARED_PROMPT = `Make one professional product photograph by blending the two uploaded products into a single physically connected arrangement.
IMAGE 1 is the RAW PHONE COVER. IMAGE 2 is the RAW CHARM. They are the only sources of product identity. Ignore their backgrounds, staging and photography defects. Do not reproduce either source photograph's layout.
Keep the cover artwork, colors, material, camera opening and physical proportions. If the raw cover is empty, show a compatible phone inside it without altering the cover. Ignore any accessory already present in the cover photo and use the separate charm upload instead.
Keep the charm's components, focal decorations, colors, materials and recognizable structure. Its flexible cord or chain may drape into a new natural pose; solid parts retain their geometry. Choose a composition suited to the actual product rather than imposing an example wristlet.
Match lighting, scale, perspective, reflections and contact shadows. Retouch noise and uneven exposure while keeping intentional texture and crisp artwork. Output the photograph only.`;
async function analyzeProduct(ai, image, mimeType, type) {
    const fallback = type === "phone cover"
        ? "Preserve the uploaded cover's artwork, materials, colors, camera opening and physical proportions."
        : "Preserve the actual uploaded charm. Use its existing attachment end and adapt the composition to its structure.";
    try {
        const payload = await ai.request("text", {
            contents: [{ role: "user", parts: [
                        { text: type === "charm"
                                ? "Describe this uploaded charm as a product reference in under 180 words. Identify its type, materials, colors, focal pieces, arrangement and existing attachment end (clasp, hook, ring, clip, cord or loop). Explain how that attachment can join a phone case using a small functional tab or cord adapter when needed. Do not prescribe a layout. Describe only visible product details; avoid invented counts or hidden hardware."
                                : "Describe this uploaded phone cover's artwork, colors, materials, camera opening and physical proportions in under 120 words. Ignore the background, pose, lighting defects and any attached accessory." },
                        { inlineData: { mimeType, data: image } },
                    ] }],
            generationConfig: { temperature: 0.1, responseModalities: ["TEXT"], maxOutputTokens: 600 },
        });
        return getParts(payload).map((part) => part.text).filter(Boolean).join("\n").trim() || fallback;
    }
    catch (error) {
        if (isFatalAiError(error))
            throw error;
        return fallback;
    }
}
function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}
async function removeChromaBackground(generatedBuffer) {
    const { data, info } = await fitCharmImage(generatedBuffer, OUTPUT_SIZE, OUTPUT_SIZE, "#00FF00")
        .flatten({ background: "#00FF00" })
        .raw()
        .toBuffer({ resolveWithObject: true });
    const pixelCount = info.width * info.height;
    const candidate = new Uint8Array(pixelCount);
    const visited = new Uint8Array(pixelCount);
    const alpha = new Uint8Array(pixelCount);
    alpha.fill(255);
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        const offset = pixel * 3;
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        if (green > 105 && green - red > 24 && green - blue > 24)
            candidate[pixel] = 1;
    }
    const queue = new Int32Array(pixelCount);
    const minimumInteriorBackground = Math.max(1800, Math.round(pixelCount * 0.0015));
    for (let start = 0; start < pixelCount; start += 1) {
        if (!candidate[start] || visited[start])
            continue;
        let head = 0;
        let tail = 0;
        let touchesBorder = false;
        let containsStrongChroma = false;
        queue[tail++] = start;
        visited[start] = 1;
        while (head < tail) {
            const pixel = queue[head++];
            const x = pixel % info.width;
            const y = Math.floor(pixel / info.width);
            const offset = pixel * 3;
            const dominance = data[offset + 1] - Math.max(data[offset], data[offset + 2]);
            if (data[offset + 1] > 180 && dominance > 100)
                containsStrongChroma = true;
            if (x === 0 || y === 0 || x === info.width - 1 || y === info.height - 1)
                touchesBorder = true;
            const neighbors = [pixel - 1, pixel + 1, pixel - info.width, pixel + info.width];
            for (const neighbor of neighbors) {
                if (neighbor < 0 || neighbor >= pixelCount || visited[neighbor] || !candidate[neighbor])
                    continue;
                const neighborX = neighbor % info.width;
                if (Math.abs(neighborX - x) > 1)
                    continue;
                visited[neighbor] = 1;
                queue[tail++] = neighbor;
            }
        }
        if (!touchesBorder && !containsStrongChroma && tail < minimumInteriorBackground)
            continue;
        for (let index = 0; index < tail; index += 1) {
            const pixel = queue[index];
            const offset = pixel * 3;
            const dominance = data[offset + 1] - Math.max(data[offset], data[offset + 2]);
            alpha[pixel] = dominance >= 130 ? 0 : clampByte(((130 - dominance) / 106) * 255);
        }
    }
    const rgba = Buffer.alloc(pixelCount * 4);
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        const rgbOffset = pixel * 3;
        const rgbaOffset = pixel * 4;
        const opacity = alpha[pixel] / 255;
        if (opacity === 0) {
            rgba[rgbaOffset] = 0;
            rgba[rgbaOffset + 1] = 0;
            rgba[rgbaOffset + 2] = 0;
        }
        else if (opacity < 1) {
            rgba[rgbaOffset] = clampByte(data[rgbOffset] / opacity);
            rgba[rgbaOffset + 1] = clampByte((data[rgbOffset + 1] - (1 - opacity) * 255) / opacity);
            rgba[rgbaOffset + 2] = clampByte(data[rgbOffset + 2] / opacity);
        }
        else {
            rgba[rgbaOffset] = data[rgbOffset];
            rgba[rgbaOffset + 1] = data[rgbOffset + 1];
            rgba[rgbaOffset + 2] = data[rgbOffset + 2];
        }
        rgba[rgbaOffset + 3] = alpha[pixel];
    }
    return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
}
async function finishTransparentImage(generatedData) {
    const generatedBuffer = Buffer.from(generatedData, "base64");
    const generatedMetadata = await sharp(generatedBuffer).metadata();
    if (generatedMetadata.hasAlpha) {
        const generatedAlpha = await sharp(generatedBuffer).rotate().extractChannel("alpha").raw().toBuffer();
        const meaningfullyTransparentPixels = generatedAlpha.reduce((count, value) => count + (value < 245 ? 1 : 0), 0);
        if (meaningfullyTransparentPixels > generatedAlpha.length * 0.02) {
            return fitCharmImage(generatedBuffer, OUTPUT_SIZE, OUTPUT_SIZE)
                .png({ compressionLevel: 9, adaptiveFiltering: true })
                .toBuffer();
        }
    }
    return removeChromaBackground(generatedBuffer);
}
async function finishOpaqueImage(generatedData, width, height) {
    return fitCharmImage(Buffer.from(generatedData, "base64"), width, height, "#FFFFFF")
        .flatten({ background: "#FFFFFF" })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
}
function canRetry(error) {
    return error instanceof AiRequestError && (error.status === 429 || error.status >= 500);
}
async function requestGeneratedImage(options) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const payload = await options.ai.request("image", options.requestBody);
            const imagePart = getParts(payload).find((part) => part.inlineData?.data || part.inline_data?.data);
            const generatedData = imagePart?.inlineData?.data || imagePart?.inline_data?.data;
            if (!generatedData)
                throw new Error(`${options.ai.label} completed ${options.failureLabel} but did not return an image.`);
            return generatedData;
        }
        catch (error) {
            lastError = error;
            if (attempt === 1 || !canRetry(error))
                break;
            await new Promise((resolve) => setTimeout(resolve, 900));
        }
    }
    throw lastError instanceof Error ? lastError : new Error(`${options.failureLabel} could not be generated.`);
}
async function verifyComposition(ai, cover, charm, image, label) {
    const preview = await sharp(image).flatten({ background: { r: 58, g: 64, b: 72 } }).png().toBuffer();
    const payload = await ai.request("text", {
        contents: [{ role: "user", parts: [
                    { text: HAND_COMPOSITION_REVIEW_PROMPT },
                    { text: "IMAGE 1 — RAW UPLOADED CHARM: product identity and actual attachment type" },
                    { inlineData: { mimeType: charm.mimeType, data: charm.data } },
                    { text: `IMAGE 2 — FINISHED CONNECTED PRODUCT PHOTOGRAPH (${label})` },
                    { inlineData: { mimeType: "image/png", data: preview.toString("base64") } },
                    { text: "IMAGE 3 — RAW UPLOADED COVER: preserve its design and natural proportions" },
                    { inlineData: { mimeType: cover.mimeType, data: cover.data } },
                ] }],
        generationConfig: { temperature: 0, responseModalities: ["TEXT"], maxOutputTokens: 900 },
    });
    return parseHandCompositionReview(getParts(payload).map((part) => part.text).filter(Boolean).join("\n").trim());
}
async function generateCharmView(ai, cover, charm, layout, index) {
    const charmOnly = layout.id === "charm-only";
    const parts = charmOnly ? [
        { text: `${layout.instruction}\nCHARM DETAILS:\n${charm.brief}` },
        { text: "IMAGE 1 — RAW UPLOADED CHARM: the only product reference" },
        { inlineData: { mimeType: charm.mimeType, data: charm.data } },
    ] : [
        { text: `${SHARED_PROMPT}\nCOMPOSITION:\n${layout.instruction}\nCOVER DETAILS:\n${cover.brief}\nCHARM DETAILS AND ATTACHMENT:\n${charm.brief}` },
        { text: "IMAGE 1 — RAW UPLOADED PHONE COVER: use only its actual cover design" },
        { inlineData: { mimeType: cover.mimeType, data: cover.data } },
        { text: "IMAGE 2 — RAW UPLOADED CHARM: use this actual accessory and attachment" },
        { inlineData: { mimeType: charm.mimeType, data: charm.data } },
    ];
    const finish = (data) => layout.transparent ? finishTransparentImage(data) : finishOpaqueImage(data, layout.output.width, layout.output.height);
    const render = async (correction, previous) => {
        const repairParts = [];
        if (previous) {
            const preview = await sharp(previous).flatten({ background: layout.transparent ? "#00FF00" : "#FFFFFF" }).png().toBuffer();
            repairParts.push({ text: "PREVIOUS ATTEMPT — repair the defects listed below; this is not a new product reference" }, { inlineData: { mimeType: "image/png", data: preview.toString("base64") } }, { text: `REPAIR: ${correction}\n${CHARM_ATTACHMENT_INSTRUCTION}\nKeep correct product details. Adjust the actual attachment end, its case anchor, lighting and pose as needed to make one believable connected product. Do not copy an example charm or impose a fixed phone size. ${layout.transparent ? "Keep empty background flat pure #00FF00." : "Keep the studio background white."}` });
        }
        const requestBody = {
            contents: [{ role: "user", parts: [...parts, ...repairParts] }],
            generationConfig: { responseModalities: ["IMAGE"], responseFormat: { image: { aspectRatio: layout.aspectRatio } } },
        };
        return finish(await requestGeneratedImage({ ai, requestBody, failureLabel: correction ? `${layout.label} attachment repair` : layout.label }));
    };
    const finished = charmOnly ? await render("") : await generateReviewedHand({
        render,
        review: (image) => verifyComposition(ai, cover, charm, image, layout.label),
    });
    return {
        id: `${Date.now()}-${layout.id}`, templateId: layout.id, order: index,
        dataUrl: `data:image/png;base64,${finished.toString("base64")}`, mimeType: "image/png", label: layout.label,
    };
}
export async function POST(request) {
    try {
        const formData = await request.formData();
        const view = formData.get("view") ?? "all";
        if (view !== "all" && !isCharmViewId(view))
            throw new AiRequestError("Choose a valid charm view to generate.", 400);
        const ai = createAiClientFromForm(formData);
        const coverFile = formData.get("cover");
        const charmFile = formData.get("charm");
        if (!(coverFile instanceof File) || !(charmFile instanceof File)) {
            return Response.json({ error: "Upload both a raw phone cover photo and a raw charm photo." }, { status: 400 });
        }
        for (const file of [coverFile, charmFile]) {
            if (!ALLOWED_TYPES.has(file.type))
                return Response.json({ error: "Use JPG, PNG, or WebP images for both uploads." }, { status: 415 });
            if (file.size > MAX_FILE_SIZE)
                return Response.json({ error: "Each upload must be smaller than 10 MB." }, { status: 413 });
        }
        const [coverData, charmData] = await Promise.all([coverFile, charmFile].map(async (file) => Buffer.from(await file.arrayBuffer()).toString("base64")));
        const active = CHARM_LAYOUTS.filter((layout) => view === "all" || layout.id === view);
        await request.reserveImages?.(active.length);
        const [coverBrief, charmBrief] = await Promise.all([
            view === "charm-only" ? Promise.resolve("") : analyzeProduct(ai, coverData, coverFile.type, "phone cover"),
            analyzeProduct(ai, charmData, charmFile.type, "charm"),
        ]);
        const cover = { data: coverData, mimeType: coverFile.type, brief: coverBrief };
        const charm = { data: charmData, mimeType: charmFile.type, brief: charmBrief };
        const completed = [];
        const failures = [];
        // Limit concurrent image requests to two; a per-view retry avoids paying for the entire set again.
        for (let start = 0; start < active.length; start += 2) {
            const batch = active.slice(start, start + 2);
            const settled = await Promise.allSettled(batch.map((layout) => generateCharmView(ai, cover, charm, layout, CHARM_LAYOUTS.indexOf(layout))));
            settled.forEach((result, offset) => {
                if (result.status === "fulfilled")
                    completed.push(result.value);
                else
                    failures.push({
                        viewId: batch[offset].id, label: batch[offset].label,
                        message: (result.reason instanceof Error ? result.reason.message : "This view could not be generated.").slice(0, 500),
                    });
            });
            const fatal = settled.find((result) => result.status === "rejected" && isFatalAiError(result.reason));
            if (fatal?.status === "rejected") {
                if (!completed.length)
                    throw fatal.reason;
                for (const layout of active.slice(start + 2))
                    failures.push({ viewId: layout.id, label: layout.label, message: "The provider stopped this request. Check its access or quota before retrying this view." });
                break;
            }
        }
        if (!completed.length)
            return Response.json({
                error: failures[0]?.message || "The charm views could not be generated. Please retry.",
                failures,
            }, { status: 502 });
        const images = completed.sort((a, b) => a.order - b.order).map((image) => ({
            id: image.id, templateId: image.templateId, label: image.label, dataUrl: image.dataUrl, mimeType: image.mimeType,
        }));
        return Response.json({ images, failures, complete: failures.length === 0, provider: ai.provider }, { headers: { "Cache-Control": "no-store" } });
    }
    catch (error) {
        return Response.json({ error: (error instanceof Error ? error.message : "Charm generation failed.").slice(0, 350) }, { status: error instanceof AiRequestError ? error.status : 500 });
    }
}
