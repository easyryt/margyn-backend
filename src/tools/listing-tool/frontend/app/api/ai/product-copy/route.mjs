import { listingFetch as fetch } from "../../../../../listing-fetch.mjs";
import { NextResponse } from "../../../../../web-response.mjs";
import { meeshoProductTitlePromptRules, normalizeProductTitle, productTitleKeywordIssues, productTitleWarnings, validGeneratedProductTitles } from "../../../../lib/product-title-validation.mjs";
export const runtime = "nodejs";
export const maxDuration = 60;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_AI_ATTEMPTS = 3;
const IMAGEKIT_URL_ENDPOINT = (process.env.IMAGEKIT_URL_ENDPOINT ??
    "https://ik.imagekit.io/t9rd9hyjk").replace(/\/$/, "");
const IMAGEKIT_PUBLIC_KEY = process.env.IMAGEKIT_PUBLIC_KEY ??
    "public_t6kVqB8y1dp/F5f+5g9rAirXjHs=";
const PRODUCT_API_BASE_URL = "http://margyn-listing.internal/api";
function cleanJson(text) {
    return text
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
}
function parseProductDetails(text) {
    const result = JSON.parse(cleanJson(text));
    if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new SyntaxError("AI must return a product-details JSON object.");
    }
    return result;
}
function getAiProvider(value) {
    if (value === "gemini" || value === "openai") {
        return value;
    }
    return (process.env.LISTING_AI_PROVIDER || process.env.AI_PROVIDER) === "openai" ? "openai" : "gemini";
}
function cleanText(value, fallback = "") {
    return String(value || fallback)
        .replace(/\s+/g, " ")
        .trim();
}
function cleanDesignCode(value) {
    return String(value || "")
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
        .slice(0, 8);
}
function cleanDesignName(value) {
    return String(value || "")
        .replace(/[^a-zA-Z\s]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .filter(Boolean)
        .slice(0, 3)
        .join(" ");
}
function isValidDesignName(value) {
    const wordCount = value.split(" ").filter(Boolean).length;
    return wordCount >= 2 && wordCount <= 3;
}
function isValidDesignCode(value) {
    return /^[A-Z]{4,8}$/.test(value);
}
function getUsedDesignCodes(value) {
    if (typeof value !== "string" || !value.trim()) {
        return [];
    }
    try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
            return parsed
                .map((item) => String(item)
                .toUpperCase()
                .replace(/[^A-Z]/g, ""))
                .filter(Boolean);
        }
    }
    catch {
        // Also supports comma-separated text.
    }
    return value
        .split(",")
        .map((item) => item
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
        .trim())
        .filter(Boolean);
}
function getRequiredField(formData, fieldName, errorLabel) {
    const value = formData.get(fieldName);
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Please select ${errorLabel} before generating titles.`);
    }
    return value.trim();
}
function createPrompt(selections, usedDesignCodes, attempt, titleCount) {
    const usedCodesText = usedDesignCodes.length > 0
        ? `
Already used design codes. Do NOT return any of these:
${usedDesignCodes.join(", ")}
`
        : "";
    const retryText = attempt > 1
        ? `
The last answer was invalid, duplicated, or did not contain the required number of valid titles.
Generate a completely new valid result.
`
        : "";
    return `
Analyze this mobile-cover product image.

The user has already selected the following required values:

Category: ${selections.category}
Phone Model: ${selections.model}
Theme: ${selections.theme}
Product Type: ${selections.productType}

Return ONLY valid JSON in this exact format:

{
  "titleOptions": [
    ""
  ],
  "color": "",
  "material": "",
  "designName": "",
  "designCode": ""
}

Title rules:
- Generate exactly ${titleCount} product title${titleCount === 1 ? "" : "s"}.
- Each title should be long, descriptive, and SEO-friendly.
- Each title must be between 55 and 100 characters.
- Every title must include the exact selected Phone Model: "${selections.model}".
- Every title must include the exact selected Product Type: "${selections.productType}".
- Use the selected Theme: "${selections.theme}" naturally in every title.
- Category "${selections.category}" must guide the title, but do not repeat unnecessary words.
- Use visible image details only where they are actually visible.
- Titles must be suitable for Indian e-commerce product listings.
- Do not use emojis, hashtags, quotation marks, prices, SKU, model code, or platform names.
- Do not claim shockproof, protective, premium, scratch resistant, raised edges,
  wireless charging, or any feature that is not clearly visible.
${meeshoProductTitlePromptRules()}

Color and material rules:
- color should be a simple value such as Transparent, Black, Pink, White, Blue.
- material must be "Silicone" only if clearly visible or already known.
- Otherwise material must be "Not specified".

Design name rules:
- designName is an internal artwork name, not the product title.
- It must contain only 2 or 3 English words.
- It must be creative, premium, memorable, and based on visible artwork.
- Do not use: Mobile, Phone, Cover, Case, Silicone, Transparent, Design, Artwork,
  SKU, Version, Model, Brand.
- Do not include product type, phone model, category, material, color,
  design number, or version.

Design code rules:
- designCode must be an abbreviation of designName.
- It must contain only uppercase A-Z letters.
- It must be 4 to 8 characters long. Never return more than 8 letters.
- Do not include numbers, spaces, hyphens, symbols, model, brand, color,
  material, design number, or version.
- Examples:
  Ocean Soul Silhouette -> OCNSLSHT
  Black Bow Velvet -> BLKBOVL
  Cream Ribbon Starlet -> CRMRBNST
  Sassy Bear Guardian -> SSYBRGRD
${usedCodesText}
${retryText}
`;
}
async function generateWithGemini({ apiKey, model, imageBase64, mimeType, prompt, }) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            contents: [
                {
                    parts: [
                        {
                            inlineData: {
                                mimeType,
                                data: imageBase64,
                            },
                        },
                        {
                            text: prompt,
                        },
                    ],
                },
            ],
            generationConfig: {
                temperature: 0.55,
                responseMimeType: "application/json",
            },
        }),
    });
    const data = (await response.json());
    if (!response.ok) {
        throw new Error(data.error?.message || "Gemini could not analyze this image.");
    }
    const responseText = data.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("")
        .trim();
    if (!responseText) {
        throw new Error("Gemini returned no product details.");
    }
    try {
        return parseProductDetails(responseText);
    }
    catch {
        throw new SyntaxError("Gemini returned invalid product details.");
    }
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
async function generateWithOpenAi({ apiKey, model, imageBase64, mimeType, prompt, titleCount, }) {
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
                    name: "product_details",
                    strict: true,
                    schema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            titleOptions: {
                                type: "array",
                                minItems: titleCount,
                                maxItems: titleCount,
                                items: { type: "string" },
                            },
                            color: { type: "string" },
                            material: { type: "string" },
                            designName: { type: "string" },
                            designCode: { type: "string" },
                        },
                        required: [
                            "titleOptions",
                            "color",
                            "material",
                            "designName",
                            "designCode",
                        ],
                    },
                },
            },
            temperature: 0.55,
            max_output_tokens: 1_000,
        }),
    });
    const data = (await response.json());
    if (!response.ok) {
        throw new Error(data.error?.message || "OpenAI could not analyze this image.");
    }
    const responseText = getOpenAiText(data);
    if (!responseText) {
        throw new Error("OpenAI returned no product details.");
    }
    try {
        return parseProductDetails(responseText);
    }
    catch {
        throw new SyntaxError("OpenAI returned invalid product details.");
    }
}
function getValidTitleOptions(value, selections, titleCount) {
    return validGeneratedProductTitles(value, { count: titleCount, model: selections.model, productType: selections.productType });
}
function imageExtension(image) {
    const fromName = image.name
        .split(".")
        .pop()
        ?.toLowerCase()
        .replace(/[^a-z0-9]/g, "");
    if (fromName && fromName.length <= 5) {
        return fromName;
    }
    if (image.type === "image/png")
        return "png";
    if (image.type === "image/webp")
        return "webp";
    return "jpg";
}
async function uploadDesignImage({ image, designCode, }) {
    const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
    if (!privateKey) {
        throw new Error("IMAGEKIT_PRIVATE_KEY is missing in .env.local. Add the private key from ImageKit Developer Options and restart the frontend.");
    }
    if (!IMAGEKIT_PUBLIC_KEY.trim()) {
        throw new Error("IMAGEKIT_PUBLIC_KEY is missing.");
    }
    const extension = imageExtension(image);
    const fileName = `${designCode.toLowerCase()}-${Date.now()}.${extension}`;
    const uploadBody = new FormData();
    uploadBody.append("file", image, fileName);
    uploadBody.append("fileName", fileName);
    uploadBody.append("folder", "/design-library");
    uploadBody.append("useUniqueFileName", "true");
    uploadBody.append("tags", `design-library,ai-design,${designCode}`);
    uploadBody.append("checks", "'file.mime' IN ['image/jpeg', 'image/png', 'image/webp']");
    const authorization = Buffer.from(`${privateKey}:`).toString("base64");
    const response = await fetch("https://upload.imagekit.io/api/v1/files/upload", {
        method: "POST",
        headers: {
            Authorization: `Basic ${authorization}`,
            Accept: "application/json",
        },
        body: uploadBody,
    });
    const result = (await response.json().catch(() => null));
    if (!response.ok || !result?.fileId) {
        throw new Error(result?.error?.message ||
            result?.message ||
            "ImageKit could not store the design image.");
    }
    const imageUrl = cleanText(result.url) ||
        (result.filePath
            ? `${IMAGEKIT_URL_ENDPOINT}/${String(result.filePath).replace(/^\//, "")}`
            : "");
    if (!imageUrl) {
        throw new Error("ImageKit uploaded the file but returned no image URL.");
    }
    return {
        imageUrl,
        thumbnailUrl: cleanText(result.thumbnailUrl) || imageUrl,
        imageFileId: cleanText(result.fileId),
        imageFilePath: cleanText(result.filePath),
        imageFileName: cleanText(result.name) || fileName,
        imageMimeType: image.type,
    };
}
async function saveGeneratedDesign({ designName, designCode, upload, selections, }) {
    const response = await fetch(`${PRODUCT_API_BASE_URL}/designs`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            designName,
            designCode,
            category: selections.category,
            theme: selections.theme,
            productType: selections.productType,
            ...upload,
            source: "ai",
        }),
        cache: "no-store",
    });
    const result = (await response.json().catch(() => null));
    if (!response.ok || !result?.design) {
        throw new Error(result?.message ||
            "The generated design could not be saved in the design library.");
    }
    return result.design;
}
export async function POST(request) {
    try {
        if (!process.env.IMAGEKIT_PRIVATE_KEY) {
            return NextResponse.json({
                error: "IMAGEKIT_PRIVATE_KEY is missing in .env.local. Add the private key from ImageKit Developer Options and restart the frontend.",
            }, { status: 500 });
        }
        const formData = await request.formData();
        const provider = getAiProvider(formData.get("provider"));
        const apiKey = provider === "openai"
            ? process.env.OPENAI_API_KEY
            : process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return NextResponse.json({
                error: provider === "openai"
                    ? "OPENAI_API_KEY is missing in .env.local."
                    : "GEMINI_API_KEY is missing in .env.local.",
            }, { status: 500 });
        }
        const selections = {
            category: getRequiredField(formData, "category", "a category"),
            model: getRequiredField(formData, "model", "a phone model"),
            theme: getRequiredField(formData, "theme", "a theme"),
            productType: getRequiredField(formData, "productType", "a product type"),
        };
        const blockedSelection = productTitleKeywordIssues(`${selections.model} ${selections.productType}`).errors;
        if (blockedSelection.length)
            return NextResponse.json({ error: `The selected model/product type contains a known Meesho title error keyword: ${blockedSelection.join(", ")}. Review the selection before generating.` }, { status: 400 });
        const image = formData.get("image");
        if (!(image instanceof File)) {
            return NextResponse.json({ error: "Please upload a product image." }, { status: 400 });
        }
        if (!image.type.startsWith("image/")) {
            return NextResponse.json({ error: "Only PNG, JPG, JPEG, and WEBP image files are allowed." }, { status: 400 });
        }
        if (image.size > MAX_IMAGE_SIZE) {
            return NextResponse.json({ error: "Image must be smaller than 10 MB." }, { status: 400 });
        }
        const usedDesignCodes = getUsedDesignCodes(formData.get("usedDesignCodes"));
        const titleCount = Number(formData.get("titleCount") || 1);
        if (!Number.isInteger(titleCount) || titleCount < 1 || titleCount > 10) {
            return NextResponse.json({ error: "Title count must be between 1 and 10." }, { status: 400 });
        }
        const imageBuffer = Buffer.from(await image.arrayBuffer());
        const imageBase64 = imageBuffer.toString("base64");
        const model = provider === "openai"
            ? (process.env.LISTING_OPENAI_CONTENT_MODEL || process.env.OPENAI_CONTENT_MODEL) || "gpt-4.1-mini"
            : (process.env.LISTING_GEMINI_CONTENT_MODEL || process.env.GEMINI_CONTENT_MODEL) || "gemini-3.6-flash";
        let finalResult = null;
        let titleOptions = [];
        let correction = "";
        for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt += 1) {
            const prompt = createPrompt(selections, usedDesignCodes, attempt, titleCount) + correction;
            let result;
            try {
                result = provider === "openai"
                    ? await generateWithOpenAi({
                        apiKey,
                        model,
                        imageBase64,
                        mimeType: image.type,
                        prompt,
                        titleCount,
                    })
                    : await generateWithGemini({
                        apiKey,
                        model,
                        imageBase64,
                        mimeType: image.type,
                        prompt,
                    });
            }
            catch (error) {
                if (!(error instanceof SyntaxError))
                    throw error;
                correction = "\nCorrection: the previous response was invalid JSON. Return only the requested JSON object.";
                continue;
            }
            const designName = cleanDesignName(result.designName);
            const designCode = cleanDesignCode(result.designCode);
            titleOptions = getValidTitleOptions(result.titleOptions, selections, titleCount);
            const blocked = Array.isArray(result.titleOptions) ? [...new Set(result.titleOptions.flatMap((title) => productTitleKeywordIssues(normalizeProductTitle(title)).errors))] : [];
            correction = `\nCorrection: ${titleCount - titleOptions.length} titles failed validation. ${blocked.length ? `Remove the known error keywords ${blocked.join(", ")} by describing the real design accurately.` : "Check 55–100 character length, exact selected model/product type, no emojis, and distinct titles."} Return the full requested set. Never truncate a title or disguise a model.`;
            const isDuplicateCode = usedDesignCodes.includes(designCode);
            if (titleOptions.length === titleCount &&
                isValidDesignName(designName) &&
                isValidDesignCode(designCode) &&
                !isDuplicateCode) {
                finalResult = {
                    ...result,
                    designName,
                    designCode,
                };
                break;
            }
        }
        if (!finalResult || titleOptions.length !== titleCount) {
            return NextResponse.json({
                error: "AI could not produce the requested titles passing the known keyword, length and product checks, with a unique design code. No invalid titles were saved. Try again or switch AI provider.",
            }, { status: 422 });
        }
        const designName = cleanDesignName(finalResult.designName);
        const designCode = cleanDesignCode(finalResult.designCode);
        const upload = await uploadDesignImage({
            image,
            designCode,
        });
        const savedDesign = await saveGeneratedDesign({
            designName,
            designCode,
            upload,
            selections,
        });
        return NextResponse.json({
            titleOptions,
            titleWarnings: productTitleWarnings(titleOptions),
            color: cleanText(finalResult.color),
            material: cleanText(finalResult.material, "Not specified"),
            designName: savedDesign.designName,
            designCode: savedDesign.designCode,
            designId: savedDesign.id,
            imageUrl: savedDesign.imageUrl,
            thumbnailUrl: savedDesign.thumbnailUrl,
        });
    }
    catch (error) {
        console.error("AI product scan error:", error);
        return NextResponse.json({
            error: error instanceof Error
                ? error.message
                : "Unable to scan the product image.",
        }, { status: 500 });
    }
}
