// Reused from the supplied image-generator project. See provenance.json.
export const AI_PROVIDERS = ["gemini", "openai"];
export function isAiProvider(value) {
    return value === "gemini" || value === "openai";
}
export function initialProvider(options, saved) {
    // Keep the user's explicit choice even if its key is temporarily unavailable.
    // Generation remains disabled until that provider is configured again.
    if (isAiProvider(saved))
        return saved;
    return options.find((option) => option.available)?.id ?? "gemini";
}
