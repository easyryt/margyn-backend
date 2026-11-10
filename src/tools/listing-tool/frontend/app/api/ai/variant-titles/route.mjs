import { NextResponse } from "../../../../../web-response.mjs";
import { listingFetch as fetch } from "../../../../../listing-fetch.mjs";
import { meeshoProductTitlePromptRules, normalizeProductTitle, productTitleKeywordIssues, productTitleWarnings, validGeneratedProductTitles } from "../../../../lib/product-title-validation.mjs";
export const runtime = "nodejs";
export const maxDuration = 60;
const MAX_TITLE_COUNT = 10;
const MAX_AI_ATTEMPTS = 3;
function cleanTitle(value) {
    return normalizeProductTitle(value);
}
function parseTitles(text) {
    const result = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    if (!result || typeof result !== "object" || Array.isArray(result))
        throw new SyntaxError("AI must return a titles JSON object.");
    return result;
}
function getAiProvider(value) {
    if (value === "gemini" || value === "openai") {
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
                    name: "variant_titles",
                    strict: true,
                    schema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            titles: {
                                type: "array",
                                minItems: count,
                                maxItems: count,
                                items: { type: "string" },
                            },
                        },
                        required: ["titles"],
                    },
                },
            },
            temperature: 0.7,
            max_output_tokens: 1_000,
        }),
    });
    const data = (await response.json());
    if (!response.ok) {
        throw new Error(data.error?.message || "OpenAI could not generate titles.");
    }
    const text = getOpenAiText(data);
    if (!text) {
        throw new Error("OpenAI returned no variant titles.");
    }
    try {
        return parseTitles(text);
    }
    catch {
        throw new SyntaxError("OpenAI returned invalid variant titles. Please try again.");
    }
}
async function generateWithGemini({ apiKey, model, prompt }) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7, responseMimeType: "application/json" },
        }),
    });
    const data = (await response.json());
    if (!response.ok)
        throw new Error(data.error?.message || "Gemini could not generate titles.");
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
    if (!text)
        return {};
    return parseTitles(text);
}
function promptFor({ parentTitle, category, model, theme, productType, count, usedTitles, forCharm, attempt, }) {
    const usedTitlesText = usedTitles.length
        ? `\nDo not reuse or closely copy any existing title:\n${usedTitles.map((title) => `- ${title}`).join("\n")}\n`
        : "";
    const charmTitleText = forCharm
        ? "\nDo not include \"With Charms\" in the title. The charm workflow adds that phrase automatically. The generated base title must be 55–88 characters so the final title stays within 100 characters.\n"
        : "";
    return `
Create exactly ${count} distinct, closely related e-commerce titles for variants of this parent product:

Parent title: ${parentTitle}
Category: ${category}
Phone model: ${model}
Theme: ${theme}
Product type: ${productType}

Return ONLY JSON in this format:
{"titles":["",""]}

Rules:
- Return exactly ${count} titles.
- Keep each title related to the parent design, but make every title meaningfully different.
- Each title must include "${model}" and "${productType}" exactly as selected.
- Use the selected theme naturally.
- Each title must be 55 to 100 characters.
- Do not use quotes, emojis, prices, SKU, version numbers, marketplace names, or unsupported product claims.
${meeshoProductTitlePromptRules()}
${attempt > 1 ? "- Correction attempt: earlier output had duplicates, invalid JSON, or titles failing keyword/length/model/type checks. Return only the still-missing valid titles. Do not repeat accepted titles and do not cut off long titles." : ""}
${usedTitlesText}${charmTitleText}
`;
}
export async function POST(request) {
    try {
        const body = (await request.json());
        const parentTitle = cleanTitle(body.parentTitle);
        const category = String(body.category || "").trim();
        const model = String(body.model || "").trim();
        const theme = String(body.theme || "").trim();
        const productType = String(body.productType || "").trim();
        const count = Number(body.count);
        const usedTitles = [parentTitle, ...(Array.isArray(body.usedTitles)
                ? Array.from(new Set(body.usedTitles
                    .map((title) => cleanTitle(title))
                    .filter(Boolean))).slice(0, 500)
                : [])];
        const forCharm = body.forCharm === true;
        if (!parentTitle || !category || !model || !theme || !productType) {
            return NextResponse.json({ error: "Parent product details are required to generate variant titles." }, { status: 400 });
        }
        if (!Number.isInteger(count) || count < 1 || count > MAX_TITLE_COUNT) {
            return NextResponse.json({ error: `Generate between 1 and ${MAX_TITLE_COUNT} variant titles at a time.` }, { status: 400 });
        }
        const blockedSelection = productTitleKeywordIssues(`${model} ${productType}`).errors;
        if (blockedSelection.length)
            return NextResponse.json({ error: `The selected model/product type contains a known Meesho title error keyword: ${blockedSelection.join(", ")}. Review the selection before generating.` }, { status: 400 });
        const provider = getAiProvider(body.provider);
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
        const aiModel = provider === "openai"
            ? (process.env.LISTING_OPENAI_CONTENT_MODEL || process.env.OPENAI_CONTENT_MODEL) || "gpt-4.1-mini"
            : (process.env.LISTING_GEMINI_CONTENT_MODEL || process.env.GEMINI_CONTENT_MODEL) || "gemini-3.6-flash";
        const acceptedTitles = [];
        for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt += 1) {
            const remaining = count - acceptedTitles.length;
            const exclusions = [...usedTitles, ...acceptedTitles];
            const prompt = promptFor({ parentTitle, category, model, theme, productType, count: remaining, usedTitles: exclusions, forCharm, attempt });
            let generated;
            try {
                const result = provider === "openai"
                    ? await generateWithOpenAi({ apiKey, model: aiModel, prompt, count: remaining })
                    : await generateWithGemini({ apiKey, model: aiModel, prompt });
                generated = result.titles;
            }
            catch (error) {
                if (!(error instanceof SyntaxError))
                    throw error;
                continue;
            }
            acceptedTitles.push(...validGeneratedProductTitles(generated, { count: remaining, model, productType, usedTitles: exclusions, forCharm }));
            if (acceptedTitles.length === count) {
                return NextResponse.json({ titles: acceptedTitles, titleWarnings: productTitleWarnings(acceptedTitles) });
            }
        }
        return NextResponse.json({ error: "AI could not finish the requested titles passing the known keyword, length, model and duplicate checks. No invalid titles were returned. Try again or switch AI provider." }, { status: 422 });
    }
    catch (error) {
        return NextResponse.json({
            error: error instanceof Error
                ? error.message
                : "Unable to generate variant titles.",
        }, { status: 500 });
    }
}
