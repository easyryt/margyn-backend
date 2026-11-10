import { NextResponse } from "../../../../../web-response.mjs";
import { listingFetch as fetch } from "../../../../../listing-fetch.mjs";
import { selectedProductTitle, selectionError, } from "../../../../lib/general-product-listing.mjs";
export const runtime = "nodejs";
export const maxDuration = 60;
const MAX_TITLE_COUNT = 10;
const MAX_AI_ATTEMPTS = 3;
function cleanTitle(value) {
    if (typeof value !== "string")
        return "";
    return value
        .replace(/[“”"']/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
function normalizeGeneratedTitle(value, selections) {
    // Normalize harmless formatting, never change an AI-supplied pack quantity.
    const title = cleanTitle(value)
        .replace(/^\d+[.)]\s+/, "")
        .replace(/\(\s*pack\s+of\s+(\d+)\s*\)\s*[.!]?$/i, (_match, quantity) => `(Pack of ${Number(quantity)})`);
    return selectedProductTitle(title, selections);
}
function parseTitles(text) {
    const value = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    return value;
}
function getProvider(value) {
    if (value === "gemini" || value === "openai")
        return value;
    return (process.env.LISTING_AI_PROVIDER || process.env.AI_PROVIDER) === "openai" ? "openai" : "gemini";
}
function getOpenAiText(data) {
    if (data.output_text?.trim())
        return data.output_text.trim();
    return data.output
        ?.flatMap((item) => item.content ?? [])
        .filter((part) => part.type === "output_text")
        .map((part) => part.text ?? "")
        .join("")
        .trim();
}
function validTitles(value, count, usedTitles, selections) {
    if (!Array.isArray(value))
        return [];
    const used = new Set(usedTitles.map((title) => title.toLowerCase()));
    const unique = new Map();
    for (const valueItem of value) {
        const title = normalizeGeneratedTitle(valueItem, selections);
        const normalized = title.toLowerCase();
        if (title && !used.has(normalized) && !unique.has(normalized)) {
            unique.set(normalized, title);
        }
    }
    return Array.from(unique.values()).slice(0, count);
}
function promptFor({ parentTitle, category, genericName, productType, color, material, quantity, includedComponents, productContext, count, usedTitles, attempt, }) {
    const previouslyUsed = usedTitles.length
        ? `\nDo not repeat any of these already accepted titles (case-insensitive):\n${usedTitles
            .map((title) => `- ${title}`)
            .join("\n")}\n`
        : "";
    return `
Create exactly ${count} distinct, accurate e-commerce titles for closely related variants of a general product.

Parent title: ${parentTitle}
Category: ${category}
Generic name: ${genericName}
Product type: ${productType}
Visible color: ${color}
Visible material: ${material}
Confirmed pack quantity: ${Number(quantity)}
Included components: ${includedComponents}
Seller's product context: ${productContext}

Return ONLY JSON in this format:
{"titles":["",""]}

Rules:
- Return exactly ${count} titles.
- Every title must be between 20 and 100 characters INCLUDING the pack suffix.
  Aim for 60-90 characters. Keep wording concise so the entire suffix fits.
- The selected category, generic name, product type, and pack quantity determine
  the product identity. Do not change them. Phone accessories are allowed if selected.
- Include the exact selected product type "${productType}" in every title.
- End each title with exactly "(Pack of ${Number(quantity)})".
- Phone Charms Holder / Lanyard Insert Tabs attach charms or a lanyard to a mobile
  case. They must not be called ID card holders, badges, or name tags.
- Do not invent colors, materials, pack counts, sizes, product features, or certifications.
- Do not use quotations, emojis, prices, SKU, version numbers, marketplace names, or unsupported claims.
- These variants describe the SAME product. Reuse accurate product keywords;
  vary phrasing, keyword order, or emphasis to make each full title distinct.
  Do not invent differences between the variants just to make titles unique.
${attempt > 1 ? `- This is correction attempt ${attempt}. Earlier output contained duplicates or invalid titles. Generate ONLY the ${count} still missing titles; check the length, exact product type, pack suffix, and exclusion list before returning JSON.` : ""}
${previouslyUsed}
`;
}
async function generateWithOpenAi({ apiKey, model, prompt, count, }) {
    const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            store: false,
            input: prompt,
            text: {
                format: {
                    type: "json_schema",
                    name: "general_product_variant_titles",
                    strict: true,
                    schema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            titles: {
                                type: "array",
                                minItems: count,
                                maxItems: count,
                                items: { type: "string", minLength: 20, maxLength: 100 },
                            },
                        },
                        required: ["titles"],
                    },
                },
            },
            temperature: 0.7,
            max_output_tokens: Math.max(1_200, count * 180),
        }),
    });
    const data = (await response.json());
    if (!response.ok) {
        throw new Error(data.error?.message || "OpenAI could not generate titles.");
    }
    const text = getOpenAiText(data);
    if (!text)
        throw new Error("OpenAI returned no variant titles.");
    return parseTitles(text);
}
async function generateWithGemini({ apiKey, model, prompt, }) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.7,
                responseMimeType: "application/json",
            },
        }),
    });
    const data = (await response.json());
    if (!response.ok) {
        throw new Error(data.error?.message || "Gemini could not generate titles.");
    }
    const text = data.candidates?.[0]?.content
        ?.parts?.map((part) => part.text || "")
        .join("")
        .trim();
    if (!text)
        throw new Error("Gemini returned no variant titles.");
    return parseTitles(text);
}
export async function POST(request) {
    const acceptedTitles = [];
    try {
        const body = (await request.json());
        const parentTitle = cleanTitle(body.parentTitle).slice(0, 100);
        const category = String(body.category || "").trim();
        const genericName = String(body.genericName || "").trim();
        const productType = String(body.productType || "").trim();
        const color = String(body.color || "Not specified").trim();
        const material = String(body.material || "Not specified").trim();
        const quantity = String(body.quantity || "").trim();
        const includedComponents = String(body.includedComponents || "").trim().slice(0, 300);
        const productContext = String(body.productContext || "").trim().slice(0, 500);
        const selections = {
            category, genericName, productType, quantity, productContext,
        };
        const validationError = selectionError(selections);
        const count = Number(body.count);
        const usedTitles = [parentTitle, ...(Array.isArray(body.usedTitles)
                ? Array.from(new Set(body.usedTitles
                    .map((title) => cleanTitle(title).slice(0, 100))
                    .filter(Boolean))).slice(0, 200)
                : [])];
        if (!parentTitle || validationError) {
            return NextResponse.json({ error: validationError || "Add the parent product title first." }, { status: 400 });
        }
        if (!Number.isInteger(count) || count < 1 || count > MAX_TITLE_COUNT) {
            return NextResponse.json({ error: `Generate between 1 and ${MAX_TITLE_COUNT} titles at a time.` }, { status: 400 });
        }
        const provider = getProvider(body.provider);
        const apiKey = provider === "openai" ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return NextResponse.json({
                error: provider === "openai"
                    ? "OPENAI_API_KEY is missing in .env.local."
                    : "GEMINI_API_KEY is missing in .env.local.",
            }, { status: 500 });
        }
        const model = provider === "openai"
            ? (process.env.LISTING_OPENAI_CONTENT_MODEL || process.env.OPENAI_CONTENT_MODEL) || "gpt-4.1-mini"
            : (process.env.LISTING_GEMINI_CONTENT_MODEL || process.env.GEMINI_CONTENT_MODEL) || "gemini-3.6-flash";
        for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt += 1) {
            const remaining = count - acceptedTitles.length;
            const exclusions = [...usedTitles, ...acceptedTitles];
            const prompt = promptFor({
                parentTitle, category, genericName, productType, color, material,
                quantity, includedComponents, productContext,
                count: remaining, usedTitles: exclusions, attempt,
            });
            try {
                const result = provider === "openai"
                    ? await generateWithOpenAi({ apiKey, model, prompt, count: remaining })
                    : await generateWithGemini({ apiKey, model, prompt });
                acceptedTitles.push(...validTitles(result.titles, remaining, exclusions, selections));
            }
            catch (error) {
                // Malformed model JSON is retryable. Provider/network errors are not
                // disguised as success, but any titles already accepted are preserved.
                if (!(error instanceof SyntaxError))
                    throw error;
            }
            if (acceptedTitles.length === count) {
                return NextResponse.json({ titles: acceptedTitles, remaining: 0 });
            }
        }
        if (acceptedTitles.length) {
            return NextResponse.json({
                titles: acceptedTitles,
                remaining: count - acceptedTitles.length,
                warning: "Some AI titles were duplicate or invalid. Continue generating the remaining titles.",
            });
        }
        return NextResponse.json({ titles: [], error: "AI returned only duplicate or invalid titles. Your saved titles are safe. Try again or switch AI provider." }, { status: 422 });
    }
    catch (error) {
        return NextResponse.json({
            titles: acceptedTitles,
            error: error instanceof Error ? error.message : "Unable to generate variant titles.",
        }, { status: 500 });
    }
}
