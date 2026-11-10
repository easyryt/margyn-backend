// Observed in the seller's Meesho rejection report, not a complete or live
// marketplace policy. Keep hard errors separate from review-only warnings.
export const MEESHO_TITLE_ERROR_KEYWORDS = ["Elements"];
export const MEESHO_TITLE_WARNING_KEYWORDS = ["iPhone", "Minimalist", "Elegant", "Butterfly", "Chic"];
export function normalizeProductTitle(value) {
    if (typeof value !== "string")
        return "";
    return value.normalize("NFKC")
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
        .replace(/[“”"']/g, "")
        .replace(/\s+/g, " ").trim();
}
function containsPhrase(title, phrase) {
    const escaped = normalizeProductTitle(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !!escaped && new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(title);
}
export function productTitleKeywordIssues(value) {
    const title = normalizeProductTitle(value);
    return {
        errors: MEESHO_TITLE_ERROR_KEYWORDS.filter((keyword) => containsPhrase(title, keyword)),
        warnings: MEESHO_TITLE_WARNING_KEYWORDS.filter((keyword) => containsPhrase(title, keyword)),
    };
}
export function productTitleKey(value, forCharm = false) {
    const title = normalizeProductTitle(value);
    return (forCharm ? title.replace(/\bwith\s+charms?\b/gi, " ").replace(/\s+/g, " ").trim() : title).toLowerCase();
}
export function validGeneratedProductTitles(value, options) {
    if (!Array.isArray(value) || !Number.isInteger(options.count) || options.count < 1)
        return [];
    const { count, model, productType, forCharm = false, usedTitles = [] } = options;
    // CharmManager adds this phrase after generation, so reserve its full length.
    const maxLength = 100 - (forCharm ? " With Charms".length : 0);
    const used = new Set(usedTitles.map((title) => productTitleKey(title, forCharm)));
    const accepted = [];
    for (const candidate of value) {
        const title = normalizeProductTitle(candidate);
        const key = productTitleKey(title, forCharm);
        if (title.length < 55 || title.length > maxLength || !containsPhrase(title, model)
            || !containsPhrase(title, productType) || productTitleKeywordIssues(title).errors.length
            || /\p{Extended_Pictographic}/u.test(title) || used.has(key)
            || (forCharm && /\bwith\s+charms?\b/i.test(title)))
            continue;
        accepted.push(title);
        used.add(key);
        if (accepted.length >= count)
            break;
    }
    return accepted;
}
export function productTitleWarnings(titles) {
    return [...new Set(titles.flatMap((title) => productTitleKeywordIssues(title).warnings))];
}
export function meeshoProductTitlePromptRules() {
    return `
- Known seller rejection feedback marks the standalone word "Elements" as an ERROR. Never use that word in a product title.
- Avoid optional marketing adjectives "Elegant", "Minimalist", and "Chic". Prefer factual, visible pattern details.
- Preserve the exact selected phone model and the real artwork (including a butterfly if visible). Do not invent features to avoid a keyword.
- Mention the phone model as compatibility using "for" or "compatible with". Do not imply the phone brand manufactured the cover.
- Never disguise a brand/model with misspellings, inserted spaces, or symbols to evade marketplace checks.
- Do not add emojis, prices, SKU codes, or unsupported product claims. Check every title before returning JSON.
`;
}
export function assertProductTitlesForExport(products) {
    for (const product of products) {
        const title = normalizeProductTitle(product.productName);
        const { errors } = productTitleKeywordIssues(title);
        const issue = errors.length ? `Meesho flagged the title word ${errors.join(", ")} as an error.`
            : !title ? "The product title is empty."
                : title.length > 100 ? "The product title is longer than 100 characters." : "";
        if (issue)
            throw new Error(`${product.sku || "Product"}: ${issue} Edit or regenerate the title before exporting. Pricing has not been changed.`);
    }
}
