// Reused from the supplied image-generator project. See provenance.json.
// Server-side adapter. API keys are kept in this closure, never returned to the UI.
import sharp from "sharp";
import { meteredFetch } from "../../../services/ai-usage.mjs";
export class AiRequestError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.name = "AiRequestError";
        this.status = status;
    }
}
export function isFatalAiError(error) {
    return error instanceof AiRequestError && [400, 401, 402, 403, 404, 429].includes(error.status);
}
export function getParts(payload) {
    return payload.candidates?.flatMap((candidate) => candidate.content?.parts ?? []) ?? [];
}
export function parseProvider(value) {
    if (value === null || value === undefined)
        return "gemini"; // Existing clients.
    if (value === "gemini" || value === "openai")
        return value;
    throw new AiRequestError("Choose Gemini or OpenAI as the AI provider.", 400);
}
export function parseQualityTier(value, provider = "gemini") {
    if (value === null || value === undefined)
        return provider === "openai" ? "quality" : "economy";
    if (value === "economy")
        return "economy";
    if (value === "quality")
        return "quality";
    throw new AiRequestError("Choose one of the image-model presets shown for your provider.", 400);
}
// Only these public profiles can be selected by a browser; never accept an
// arbitrary client-supplied model, resolution or quality setting.
function providerConfig(provider, env, tier = "economy") {
    const prefix = provider.toUpperCase();
    const limits = {
        referenceEdge: Number(env[`${prefix}_REFERENCE_MAX_EDGE`]?.trim() || "512"),
        analysisEdge: Number(env[`${prefix}_ANALYSIS_MAX_EDGE`]?.trim() || "512"),
        maxOutputTokens: Number(env[`${prefix}_MAX_OUTPUT_TOKENS`]?.trim() || "600"),
    };
    if (provider === "gemini") {
        const resolution = tier === "quality" ? "2K" : env.GEMINI_IMAGE_SIZE?.trim() || "1K";
        return {
            id: provider, label: "Gemini", apiKey: env.GEMINI_API_KEY?.trim() || "", keyName: "GEMINI_API_KEY",
            ...limits,
            imageModel: tier === "quality" ? "gemini-3-pro-image" : env.GEMINI_IMAGE_MODEL?.trim() || "gemini-3.1-flash-lite-image",
            contentModel: env.GEMINI_CONTENT_MODEL?.trim() || "gemini-3.1-flash-lite",
            resolution, quality: "", settingsLabel: tier === "quality" ? "2K Pro images · higher-detail inputs · higher cost" : `${resolution} economy images · compact inputs · capped analysis`,
        };
    }
    const quality = tier === "quality" ? "low" : env.OPENAI_IMAGE_QUALITY?.trim() || "low";
    return {
        id: provider, label: "OpenAI", apiKey: env.OPENAI_API_KEY?.trim() || "", keyName: "OPENAI_API_KEY",
        ...limits,
        imageModel: tier === "quality" ? "gpt-image-2.5-flare" : env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-1-mini",
        contentModel: env.OPENAI_CONTENT_MODEL?.trim() || "gpt-6-luna",
        resolution: "1K", quality, settingsLabel: tier === "quality" ? "1K images · low quality · compact inputs · capped analysis" : `1K images · ${quality} quality · compact inputs · capped analysis`,
    };
}
export function getProviderOptions(env = process.env) {
    return ["gemini", "openai"].map((provider) => {
        const defaultQualityTier = parseQualityTier(null, provider);
        const config = providerConfig(provider, env, defaultQualityTier);
        return {
            id: provider, label: config.label, available: Boolean(config.apiKey),
            imageModel: config.imageModel, contentModel: config.contentModel, settingsLabel: config.settingsLabel,
            defaultQualityTier,
            qualityOptions: ["economy", "quality"].map((id) => {
                const profile = providerConfig(provider, env, id);
                return { id, label: id === "economy" ? "Economy" : provider === "openai" ? "Flare · low quality" : "High quality", imageModel: profile.imageModel, settingsLabel: profile.settingsLabel };
            }),
        };
    });
}
export function createAiClientFromForm(form) {
    for (const field of ["provider", "qualityTier"]) {
        if (form.getAll(field).length > 1)
            throw new AiRequestError(`Choose one ${field === "provider" ? "AI provider" : "quality tier"}.`, 400);
    }
    return createAiClient(form.get("provider"), process.env, meteredFetch, form.get("qualityTier"));
}
export function createAiClient(value, env = process.env, fetcher = meteredFetch, qualityValue) {
    const provider = parseProvider(value);
    const qualityTier = parseQualityTier(qualityValue, provider);
    const config = providerConfig(provider, env, qualityTier);
    if (!config.apiKey)
        throw new AiRequestError(`${config.label} is not configured. Add ${config.keyName} to .env.local and restart the app.`, 503);
    if (provider === "gemini" && !["1K", "2K", "4K"].includes(config.resolution)) {
        throw new AiRequestError("GEMINI_IMAGE_SIZE must be 1K, 2K, or 4K.", 503);
    }
    if (provider === "gemini" && config.imageModel.startsWith("gemini-3.1-flash-lite-image") && config.resolution !== "1K") {
        throw new AiRequestError("Gemini Flash Lite Image supports only 1K. Set GEMINI_IMAGE_SIZE=1K.", 503);
    }
    if (provider === "openai" && !["low", "medium", "high"].includes(config.quality)) {
        throw new AiRequestError("OPENAI_IMAGE_QUALITY must be low, medium, or high.", 503);
    }
    const prefix = provider.toUpperCase();
    for (const [name, limit] of [["REFERENCE_MAX_EDGE", config.referenceEdge], ["ANALYSIS_MAX_EDGE", config.analysisEdge]]) {
        if (!Number.isInteger(limit) || limit < 256 || limit > 2048) {
            throw new AiRequestError(`${prefix}_${name} must be a whole number from 256 to 2048.`, 503);
        }
    }
    if (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens < 128 || config.maxOutputTokens > 1200) {
        throw new AiRequestError(`${prefix}_MAX_OUTPUT_TOKENS must be a whole number from 128 to 1200.`, 503);
    }
    async function compactInput(part, kind) {
        const { referenceRole, ...cleanPart } = part;
        const data = cleanPart.inlineData?.data || cleanPart.inline_data?.data;
        if (!data)
            return cleanPart;
        const baseEdge = kind === "image" ? config.referenceEdge : config.analysisEdge;
        const edge = provider === "gemini" && qualityTier === "quality" && kind === "image"
            ? Math.max(baseEdge, referenceRole === "product" ? 1536 : 1024)
            : referenceRole === "product" ? Math.max(baseEdge, 1024) : baseEdge;
        try {
            const original = Buffer.from(data, "base64");
            const metadata = await sharp(original, { limitInputPixels: 40_000_000 }).metadata();
            if (metadata.width <= edge && metadata.height <= edge && (!metadata.orientation || metadata.orientation === 1))
                return cleanPart;
            const resized = sharp(original, { limitInputPixels: 40_000_000 }).rotate()
                .resize(edge, edge, { fit: "inside", withoutEnlargement: true });
            // Keep alpha for cutouts, and reduce opaque photo transfer size with JPEG.
            const alpha = metadata.hasAlpha === true;
            const compact = await (alpha ? resized.png({ compressionLevel: 9 }) : resized.jpeg({ quality: referenceRole === "product" ? 90 : 75 })).toBuffer();
            return { ...cleanPart, inlineData: { data: compact.toString("base64"), mimeType: alpha ? "image/png" : "image/jpeg" } };
        }
        catch {
            throw new AiRequestError(`${config.label} could not read an image reference. Upload a valid JPG, PNG, or WebP.`, 400);
        }
    }
    async function send(url, init, kind) {
        try {
            const response = await fetcher(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(kind === "image" ? 240_000 : 90_000) });
            const payload = await response.json().catch(() => null);
            if (!response.ok) {
                const detail = typeof payload?.error?.message === "string" ? payload.error.message : `Request failed (${response.status}).`;
                // Do not expose credentials even if an upstream error happens to echo them.
                const safeDetail = detail.split(config.apiKey).join("[redacted]").replace(/sk-[\w-]+/g, "[redacted]");
                throw new AiRequestError(`${config.label}: ${safeDetail.slice(0, 350)}`, response.status);
            }
            if (!payload)
                throw new AiRequestError(`${config.label} returned an unreadable response.`, 502);
            return payload;
        }
        catch (error) {
            if (error instanceof AiRequestError)
                throw error;
            // A timeout is ambiguous: do not automatically bill another image request.
            throw new AiRequestError(`${config.label} could not be reached or timed out. Please try again.`, 408);
        }
    }
    return {
        provider,
        label: config.label,
        qualityTier,
        imageModel: config.imageModel,
        async request(kind, body) {
            const { jsonSchema, ...settings } = body.generationConfig ?? {};
            // Apply the budget before either provider receives any reference or review image.
            const contents = await Promise.all(body.contents.map(async (entry) => ({ ...entry,
                parts: await Promise.all(entry.parts.map((part) => compactInput(part, kind))),
            })));
            if (provider === "gemini") {
                const model = kind === "image" ? config.imageModel : config.contentModel;
                const generationConfig = kind === "image" ? {
                    ...settings,
                    responseFormat: { image: {
                            ...(settings.responseFormat?.image?.aspectRatio ? { aspectRatio: settings.responseFormat.image.aspectRatio } : {}),
                            imageSize: { "1K": "IMAGE_SIZE_ONE_K", "2K": "IMAGE_SIZE_TWO_K", "4K": "IMAGE_SIZE_FOUR_K" }[config.resolution],
                        } },
                } : { ...settings,
                    ...(jsonSchema ? { responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: jsonSchema.schema } } } : {}),
                    maxOutputTokens: Math.min(settings.maxOutputTokens ?? config.maxOutputTokens, config.maxOutputTokens) };
                // Minimal is supported by Flash Lite text and image models. Do not send
                // model-specific thinking settings to unrelated env overrides.
                const thinking = model.startsWith("gemini-3.1-flash-lite")
                    ? { thinkingConfig: { thinkingLevel: "minimal", includeThoughts: false } } : {};
                const payload = await send(`https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(model)}:generateContent`, {
                    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
                    body: JSON.stringify({ ...body, contents, generationConfig: { ...generationConfig, ...thinking } }),
                }, kind);
                if (payload.candidates?.some((candidate) => candidate.finishReason === "MAX_TOKENS")) {
                    throw new AiRequestError("Gemini's analysis exceeded its token limit; no incomplete review was accepted.", 422);
                }
                return payload;
            }
            const parts = contents.flatMap((content) => content.parts);
            const headers = { Authorization: `Bearer ${config.apiKey}` };
            if (kind === "image") {
                const form = new FormData();
                form.set("model", config.imageModel);
                form.set("n", "1");
                form.set("quality", config.quality);
                if (config.imageModel.startsWith("gpt-image-1"))
                    form.set("input_fidelity", "low");
                form.set("output_format", "png");
                if (settings.responseFormat?.image?.background)
                    form.set("background", settings.responseFormat.image.background);
                const portrait = body.generationConfig?.responseFormat?.image?.aspectRatio === "ASPECT_RATIO_THREE_BY_FOUR";
                // Current GPT Image models support exact 3:4; older env overrides use their supported portrait size.
                form.set("size", portrait ? (config.imageModel.startsWith("gpt-image-2") ? "960x1280" : "1024x1536") : "1024x1024");
                const prompt = [];
                let count = 0;
                for (const part of parts) {
                    if (part.text)
                        prompt.push(part.text);
                    const data = part.inlineData?.data || part.inline_data?.data;
                    if (data) {
                        count += 1;
                        const mimeType = part.inlineData?.mimeType || part.inline_data?.mime_type || "image/png";
                        const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
                        form.append("image[]", new Blob([new Uint8Array(Buffer.from(data, "base64"))], { type: mimeType }), `reference-${count}.${extension}`);
                        prompt.push(`[Attached image ${count}]`);
                    }
                }
                if (!count)
                    throw new AiRequestError("Image editing requires at least one reference image.", 400);
                form.set("prompt", prompt.join("\n\n"));
                const payload = await send("https://api.openai.com/v1/images/edits", { method: "POST", headers, body: form }, kind);
                const data = payload.data?.[0]?.b64_json;
                if (typeof data !== "string" || !data)
                    throw new AiRequestError("OpenAI did not return an edited image.", 422);
                return { candidates: [{ content: { parts: [{ inlineData: { data, mimeType: "image/png" } }] } }] };
            }
            const content = parts.flatMap((part) => {
                const result = [];
                if (part.text)
                    result.push({ type: "input_text", text: part.text });
                const data = part.inlineData?.data || part.inline_data?.data;
                if (data)
                    result.push({ type: "input_image", image_url: `data:${part.inlineData?.mimeType || part.inline_data?.mime_type || "image/png"};base64,${data}`, detail: "auto" });
                return result;
            });
            const payload = await send("https://api.openai.com/v1/responses", {
                method: "POST", headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: config.contentModel, input: [{ role: "user", content }], store: false,
                    ...(jsonSchema ? { text: { format: { type: "json_schema", name: jsonSchema.name, strict: true, schema: jsonSchema.schema } } } : {}),
                    max_output_tokens: Math.min(body.generationConfig?.maxOutputTokens ?? config.maxOutputTokens, config.maxOutputTokens),
                    ...(/^gpt-(5|6)/.test(config.contentModel) ? { reasoning: { effort: "none" } } : {}),
                }),
            }, kind);
            if (payload.status !== "completed")
                throw new AiRequestError("OpenAI's analysis was incomplete; no incomplete review was accepted.", 422);
            const text = (payload.output ?? []).flatMap((item) => item.content ?? [])
                .filter((item) => item.type === "output_text").map((item) => item.text).join("\n").trim();
            if (!text)
                throw new AiRequestError("OpenAI did not return an analysis response.", 422);
            return { candidates: [{ content: { parts: [{ text }] } }] };
        },
    };
}
