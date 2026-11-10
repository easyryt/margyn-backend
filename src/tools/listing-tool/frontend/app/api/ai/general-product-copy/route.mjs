import { NextResponse } from "../../../../../web-response.mjs";
import { listingFetch as fetch } from "../../../../../listing-fetch.mjs";
import { createGeneralProductSku, generalProductCode, generalProductSkuCodesForListing, selectedProductTitle, selectionError, } from "../../../../lib/general-product-listing.mjs";
export const runtime = "nodejs";
export const maxDuration = 60;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_AI_ATTEMPTS = 3;
function cleanJson(text) {
    return text
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
}
function cleanText(value, fallback = "", limit = 500) {
    return String(value || fallback)
        .replace(/[“”"']/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, limit);
}
function getProvider(value) {
    if (value === "openai" || value === "gemini") {
        return value;
    }
    return (process.env.LISTING_AI_PROVIDER || process.env.AI_PROVIDER) === "openai" ? "openai" : "gemini";
}
function getOpenAiText(data) {
    if (data.output_text?.trim()) {
        return data.output_text.trim();
    }
    return data.output
        ?.flatMap((item) => item.content ?? [])
        .filter((part) => part.type === "output_text")
        .map((part) => part.text ?? "")
        .join("")
        .trim();
}
function promptForImage(selections, brandCode) {
    return `
Analyze this product image for an Indian e-commerce listing.

The seller has confirmed these product details. They determine the identity of the
product and MUST take precedence over guesses based on its shape:
${JSON.stringify(selections)}

Use the image only for visible appearance, color, material, and construction.
Do not change the selected category, generic name, product type, or pack quantity.
No phone model is required. Phone-related accessories ARE allowed when selected.
In particular, Phone Charms Holder / Lanyard Insert Tabs are small tabs placed
inside a mobile case to attach a phone charm or lanyard. Transparent tabs with
metal eyelets must not be relabeled ID card holders, badges, or name tags.

For a transparent Phone Charms Holder with lanyard insert tabs, a suitable title is:
Universal Transparent Mobile Case Lanyard Insert Tabs Phone Charms Holder (Pack of ${Number(selections.quantity)})
This example applies only to that selected product type and visible appearance.

Return ONLY valid JSON in this exact shape:
{
  "title": "",
  "category": "",
  "genericName": "",
  "productType": "",
  "variation": "",
  "color": "",
  "material": "",
  "theme": "",
  "description": "",
  "includedComponents": "",
  "netQuantity": "",
  "weightGrams": "",
  "skuCodes": { "productCode": "", "colorCode": "" }
}

Rules:
- title must be a 20-100 character, accurate product title suitable for India.
- Include the exact selected product type "${selections.productType}" naturally.
- End the title with exactly "(Pack of ${Number(selections.quantity)})".
- Do not include price, SKU, version, platform names, hashtags, emojis, quotation marks,
  or unsupported claims such as premium, waterproof, durable, or heavy duty.
- Use the seller-confirmed identity/use and visible image details. Do not invent features.
- category must be exactly "${selections.category}".
- genericName must be exactly "${selections.genericName}".
- productType must be exactly "${selections.productType}".
- variation must be a size/variation value. Use "Free Size" when no size is visible.
- color and material must be simple values. Use "Not specified" when unsure.
- theme is a short visual theme, or "Not specified" when there is none.
- description should be 2 concise sentences based only on visible information.
- includedComponents should say what comes in the package, or "Not specified" when unknown.
- netQuantity must be exactly "${Number(selections.quantity)}". Count the whole pack,
  not only the items shown in the demonstration photograph.
- weightGrams must be a whole-number string only when visible; otherwise use "".
- skuCodes must describe THIS generated title and the visible product, not a fixed holder/gold default.
- productCode: a short meaningful uppercase alphanumeric product abbreviation (1-12 characters).
  Examples: Phone Charms Holder=HLDR, Lanyard Insert Tabs=TAB, Craft Beads=BEAD,
  Decorative Charms=CHARM, Hair Clips=CLIP, Storage Containers=CONT. For another
  product type, choose its own meaningful abbreviation.
- colorCode: GLD for gold/golden, SLV for silver, BLK for black, WHT for white,
  PNK for pink, BLU for blue, RED for red, GRN for green, YLW for yellow,
  MULTI for multicolor, TRNS for transparent/clear, NA if not specified.
  For transparent holders with visibly gold metal eyelets use GLD; silver eyelets use SLV.
  Never guess a finish that is not visible or seller-confirmed.
- The app combines brand ${brandCode}, the selected category, these product/color codes,
  the confirmed pack quantity and a unique version into BRAND-CATEGORY-PRODUCT-COLOR-NPC-V1.
  Example: a gold-eyelet Phone Charms Holder (Pack of 3) uses MBRO-CHM-HLDR-GLD-3PC-V1.
  Do NOT include a SKU in the title, and do not put quantity or version inside either code.
`;
}
async function generateWithGemini({ apiKey, model, imageBase64, mimeType, prompt, }) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [
                {
                    parts: [
                        { inlineData: { mimeType, data: imageBase64 } },
                        { text: prompt },
                    ],
                },
            ],
            generationConfig: {
                temperature: 0.35,
                responseMimeType: "application/json",
            },
        }),
    });
    const data = (await response.json());
    if (!response.ok) {
        throw new Error(data.error?.message || "Gemini could not analyze this image.");
    }
    const text = data.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("")
        .trim();
    if (!text) {
        throw new Error("Gemini returned no product details.");
    }
    return JSON.parse(cleanJson(text));
}
async function generateWithOpenAi({ apiKey, model, imageBase64, mimeType, prompt, }) {
    const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            store: false,
            input: [
                {
                    role: "user",
                    content: [
                        { type: "input_text", text: prompt },
                        {
                            type: "input_image",
                            image_url: `data:${mimeType};base64,${imageBase64}`,
                            detail: "high",
                        },
                    ],
                },
            ],
            text: {
                format: {
                    type: "json_schema",
                    name: "general_product_detection",
                    strict: true,
                    schema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            title: { type: "string" },
                            category: { type: "string" },
                            genericName: { type: "string" },
                            productType: { type: "string" },
                            variation: { type: "string" },
                            color: { type: "string" },
                            material: { type: "string" },
                            theme: { type: "string" },
                            description: { type: "string" },
                            includedComponents: { type: "string" },
                            netQuantity: { type: "string" },
                            weightGrams: { type: "string" },
                            skuCodes: {
                                type: "object",
                                additionalProperties: false,
                                properties: { productCode: { type: "string" }, colorCode: { type: "string" } },
                                required: ["productCode", "colorCode"],
                            },
                        },
                        required: [
                            "title",
                            "category",
                            "genericName",
                            "productType",
                            "variation",
                            "color",
                            "material",
                            "theme",
                            "description",
                            "includedComponents",
                            "netQuantity",
                            "weightGrams",
                            "skuCodes",
                        ],
                    },
                },
            },
            temperature: 0.35,
            max_output_tokens: 1_200,
        }),
    });
    const data = (await response.json());
    if (!response.ok) {
        throw new Error(data.error?.message || "OpenAI could not analyze this image.");
    }
    const text = getOpenAiText(data);
    if (!text) {
        throw new Error("OpenAI returned no product details.");
    }
    return JSON.parse(cleanJson(text));
}
function imageExtension(image) {
    const extension = image.name
        .split(".")
        .pop()
        ?.toLowerCase()
        .replace(/[^a-z0-9]/g, "");
    if (extension && extension.length <= 5)
        return extension;
    if (image.type === "image/png")
        return "png";
    if (image.type === "image/webp")
        return "webp";
    return "jpg";
}
async function loadHostedProductImage(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error("Upload an image or enter a valid hosted image URL.");
    }
    // Never turn this endpoint into an arbitrary internal-network proxy.
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
        || !["upload.meeshosupplyassets.com", "ik.imagekit.io"].includes(url.hostname)) {
        throw new Error("For AI generation, use a Meesho/ImageKit image URL or upload the image file.");
    }
    const response = await fetch(url.href, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    const mimeType = response.headers.get("content-type")?.split(";")[0].trim() || "";
    if (!response.ok || !response.body || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
        throw new Error("Unable to read this hosted image. Upload its image file instead.");
    }
    if (Number(response.headers.get("content-length")) > MAX_IMAGE_SIZE)
        throw new Error("Image must be smaller than 10 MB.");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done)
                break;
            size += part.value.byteLength;
            if (size > MAX_IMAGE_SIZE) {
                await reader.cancel();
                throw new Error("Image must be smaller than 10 MB.");
            }
            chunks.push(part.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    return new File([Buffer.concat(chunks)], "hosted-product-image", { type: mimeType });
}
async function uploadImageIfConfigured(image) {
    const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
    if (!privateKey) {
        return {
            imageUrl: "",
            imageUploadMessage: "Image was analyzed but not hosted. Add IMAGEKIT_PRIVATE_KEY to store an Excel-ready image URL.",
        };
    }
    const uploadBody = new FormData();
    const fileName = `general-product-${Date.now()}.${imageExtension(image)}`;
    uploadBody.append("file", image, fileName);
    uploadBody.append("fileName", fileName);
    uploadBody.append("folder", "/general-product-listings");
    uploadBody.append("useUniqueFileName", "true");
    uploadBody.append("tags", "general-product,ai-listing");
    try {
        const response = await fetch("https://upload.imagekit.io/api/v1/files/upload", {
            method: "POST",
            headers: {
                Authorization: `Basic ${Buffer.from(`${privateKey}:`).toString("base64")}`,
                Accept: "application/json",
            },
            body: uploadBody,
        });
        const result = (await response.json().catch(() => null));
        if (!response.ok || !result?.fileId || !result.url) {
            return {
                imageUrl: "",
                imageUploadMessage: result?.error?.message ||
                    result?.message ||
                    "Image was analyzed but could not be hosted. Add its marketplace URL before export.",
            };
        }
        return { imageUrl: result.url, imageUploadMessage: "" };
    }
    catch {
        return {
            imageUrl: "",
            imageUploadMessage: "Image was analyzed but could not be hosted. Add its marketplace URL before export.",
        };
    }
}
function toResponse(detection, selections, imageUrl, imageUploadMessage, brandCode) {
    const title = selectedProductTitle(detection.title, selections);
    const color = cleanText(detection.color, "Not specified", 80);
    const skuCodes = generalProductSkuCodesForListing({ ...selections, productName: title, color, brandCode }, detection.skuCodes);
    const sku = createGeneralProductSku(skuCodes, selections.quantity);
    return {
        title,
        skuCodes,
        sku,
        styleId: sku,
        category: selections.category,
        genericName: selections.genericName,
        productType: selections.productType,
        variation: cleanText(detection.variation, "Free Size", 80),
        color,
        material: cleanText(detection.material, "Not specified", 80),
        theme: cleanText(detection.theme, "Not specified", 120),
        description: cleanText(detection.description, "", 1_000),
        includedComponents: cleanText(detection.includedComponents, "Not specified", 300),
        netQuantity: String(Number(selections.quantity)),
        weightGrams: cleanText(detection.weightGrams, "", 20).replace(/[^0-9]/g, ""),
        imageUrl,
        imageUploadMessage,
    };
}
export async function POST(request) {
    try {
        const formData = await request.formData();
        const selections = {
            category: cleanText(formData.get("category"), "", 120),
            genericName: cleanText(formData.get("genericName"), "", 120),
            productType: cleanText(formData.get("productType"), "", 60),
            quantity: cleanText(formData.get("quantity"), "", 10),
            productContext: cleanText(formData.get("productContext"), "", 500),
        };
        const validationError = selectionError(selections);
        if (validationError) {
            return NextResponse.json({ error: validationError }, { status: 400 });
        }
        const provider = getProvider(formData.get("provider"));
        const brandCode = generalProductCode(cleanText(formData.get("brandCode"), "MBRO", 100), "MBRO");
        const apiKey = provider === "openai" ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return NextResponse.json({
                error: provider === "openai"
                    ? "OPENAI_API_KEY is missing in .env.local."
                    : "GEMINI_API_KEY is missing in .env.local.",
            }, { status: 500 });
        }
        const uploadedImage = formData.get("image");
        const hostedImageUrl = uploadedImage instanceof File ? "" : cleanText(formData.get("imageUrl"), "", 2048);
        let image;
        if (uploadedImage instanceof File)
            image = uploadedImage;
        else if (hostedImageUrl) {
            try {
                image = await loadHostedProductImage(hostedImageUrl);
            }
            catch (error) {
                return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load image." }, { status: 400 });
            }
        }
        else {
            return NextResponse.json({ error: "Please upload a product image or use its hosted image URL." }, { status: 400 });
        }
        if (!["image/png", "image/jpeg", "image/webp"].includes(image.type)) {
            return NextResponse.json({ error: "Only PNG, JPG, JPEG, and WEBP image files are allowed." }, { status: 400 });
        }
        if (image.size === 0 || image.size > MAX_IMAGE_SIZE) {
            return NextResponse.json({ error: "Image must be smaller than 10 MB." }, { status: 400 });
        }
        const imageBase64 = Buffer.from(await image.arrayBuffer()).toString("base64");
        const model = provider === "openai"
            ? (process.env.LISTING_OPENAI_CONTENT_MODEL || process.env.OPENAI_CONTENT_MODEL) || "gpt-4.1-mini"
            : (process.env.LISTING_GEMINI_CONTENT_MODEL || process.env.GEMINI_CONTENT_MODEL) || "gemini-3.6-flash";
        const prompt = promptForImage(selections, brandCode);
        for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt += 1) {
            try {
                const detection = provider === "openai"
                    ? await generateWithOpenAi({
                        apiKey,
                        model,
                        imageBase64,
                        mimeType: image.type,
                        prompt,
                    })
                    : await generateWithGemini({
                        apiKey,
                        model,
                        imageBase64,
                        mimeType: image.type,
                        prompt,
                    });
                const result = toResponse(detection, selections, "", "", brandCode);
                if (result.title) {
                    const upload = hostedImageUrl ? { imageUrl: hostedImageUrl, imageUploadMessage: "" } : await uploadImageIfConfigured(image);
                    return NextResponse.json({ ...result, ...upload });
                }
            }
            catch (error) {
                if (!(error instanceof SyntaxError) || attempt === MAX_AI_ATTEMPTS)
                    throw error;
            }
        }
        return NextResponse.json({ error: "AI could not produce a title matching your product type and pack quantity. Check your selections and try again." }, { status: 500 });
    }
    catch (error) {
        console.error("General product AI scan error:", error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Unable to scan the product image.",
        }, { status: 500 });
    }
}
