// Ported from the supplied shipping-labels-tool. See provenance.json.
function normalize(text) {
    return text
        .replace(/\r/g, "")
        .replace(/\t/g, " ")
        .replace(/[\u0000-\u001F]/g, " ")
        .replace(/\uFFFE/g, " ")
        .replace(/\uFFFF/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function cleanSku(sku) {
    return sku
        .replace(/\uFFFE/g, "")
        .replace(/\uFFFF/g, "")
        .replace(/\s+/g, "")
        .replace(/[‐-‒–—−]/g, "-")
        .replace(/-+/g, "-")
        .replace(/[^A-Z0-9.-]/gi, "")
        .toUpperCase()
        .trim();
}
function extractSku(text) {
    const patterns = [
        /SKU\s+Size\s+Qty\s+Color\s+Order\s*No\.?\s*([\s\S]{0,250})/i,
        /Product\s+Details[\s\S]{0,100}SKU([\s\S]{0,250})/i,
    ];
    for (const pattern of patterns) {
        const section = text.match(pattern);
        if (!section)
            continue;
        const value = section[1];
        const end = value.search(/Free\s*Size|Small|Medium|Large|XL|XXL/i);
        const sku = end > -1
            ? value.substring(0, end)
            : value;
        const cleaned = cleanSku(sku);
        if (cleaned.length > 8) {
            return cleaned;
        }
    }
    const fallback = text.match(/([A-Z0-9-]{10,}(?:\s*[A-Z0-9.-]+){0,8})/);
    if (fallback) {
        return cleanSku(fallback[1]);
    }
    return "";
}
function extractOrderNumber(text) {
    const patterns = [
        /\d{18}_\d+/,
        /\d{17,22}_\d+/,
        /Purchase\s*Order\s*No\.?\s*(\d{15,22})/i,
    ];
    for (const p of patterns) {
        const match = text.match(p);
        if (!match)
            continue;
        return match[1] ?? match[0];
    }
    return "";
}
function extractProduct(text) {
    const start = text.indexOf("Description");
    if (start === -1) {
        return "Unknown Product";
    }
    let block = text.substring(start);
    block = block.replace(/^Description/i, "");
    const stopWords = [
        "Other Charges",
        "Total",
        "IGST",
        "CGST",
        "SGST",
        "Tax is not payable",
    ];
    let end = block.length;
    for (const stop of stopWords) {
        const index = block.indexOf(stop);
        if (index !== -1) {
            end = Math.min(end, index);
        }
    }
    block = block.substring(0, end);
    block = block.replace(/\b3926\d*\b/g, "");
    block = block.replace(/\bRs\.[0-9.]+\b/g, "");
    block = block.replace(/\bQty\b/g, "");
    block = block.replace(/\bDiscount\b/g, "");
    block = block.replace(/\bGross Amount\b/g, "");
    block = block.replace(/\bTaxable Value\b/g, "");
    block = block.replace(/\bTaxes\b/g, "");
    block = block.replace(/\s+/g, " ");
    return block.trim();
}
export function extractOrder(text, pageNumber) {
    const normalized = normalize(text);
    return {
        pageNumber,
        sku: extractSku(normalized),
        orderNo: extractOrderNumber(normalized),
        productName: extractProduct(normalized),
    };
}
