export const GENERAL_PRODUCT_CATEGORIES = [
    {
        name: "Beads & Charms",
        code: "CHM",
        genericNames: ["Beads & Charms"],
        productTypes: [
            { name: "Phone Charms Holder", code: "HLDR" },
            { name: "Lanyard Insert Tabs", code: "TAB" },
            { name: "Craft Beads", code: "BEAD" },
            { name: "Decorative Charms", code: "CHARM" },
            { name: "Pendant Charms", code: "PNDT" },
            { name: "Keychain Charms", code: "KEY" },
            { name: "Bracelet Charms", code: "BRCL" },
        ],
    },
    {
        name: "Hair Accessories",
        code: "HAIR",
        genericNames: ["Hair Accessories", "Hair Clips", "Hair Bands"],
        productTypes: [
            { name: "Hair Clips", code: "CLIP" },
            { name: "Hair Bands", code: "BAND" },
            { name: "Hair Scrunchies", code: "SCRN" },
        ],
    },
    {
        name: "Kitchen & Dining",
        code: "KTCH",
        genericNames: ["Kitchen Accessories", "Storage Containers", "Utensils"],
        productTypes: [
            { name: "Storage Containers", code: "CONT" },
            { name: "Kitchen Organizers", code: "ORGN" },
            { name: "Cooking Utensils", code: "UTNS" },
        ],
    },
    {
        name: "Home Decor",
        code: "HOME",
        genericNames: ["Home Decor", "Decorative Items"],
        productTypes: [
            { name: "Decorative Stickers", code: "STKR" },
            { name: "Wall Hangings", code: "WALL" },
            { name: "Artificial Flowers", code: "FLWR" },
        ],
    },
    {
        name: "Stationery",
        code: "STN",
        genericNames: ["Stationery", "Art & Craft Supplies"],
        productTypes: [
            { name: "Craft Stickers", code: "STKR" },
            { name: "Notebooks", code: "NOTE" },
            { name: "Pens", code: "PEN" },
        ],
    },
    {
        name: "Jewellery & Accessories",
        code: "JWL",
        genericNames: ["Jewellery", "Fashion Accessories"],
        productTypes: [
            { name: "Bracelets", code: "BRCL" },
            { name: "Necklaces", code: "NCKL" },
            { name: "Earrings", code: "EAR" },
            { name: "Keychains", code: "KEY" },
        ],
    },
];
export function generalProductCode(value, fallback = "GEN") {
    return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || fallback;
}
export function generalProductColorCode(color) {
    const codes = {
        gold: "GLD", golden: "GLD", silver: "SLV", transparent: "TRNS",
        clear: "TRNS", black: "BLK", white: "WHT", pink: "PNK", blue: "BLU",
        red: "RED", green: "GRN", yellow: "YLW", multicolor: "MULTI",
        multicolour: "MULTI", "not specified": "NA",
    };
    return codes[color.toLowerCase().trim()] || generalProductCode(color, "NA");
}
export function generalProductSkuCodesForListing(listing, detectedCodes) {
    const detected = detectedCodes && typeof detectedCodes === "object" && !Array.isArray(detectedCodes)
        ? detectedCodes : {};
    const readCode = (value) => typeof value === "string" && /^[A-Z0-9]{1,12}$/i.test(value.trim())
        ? value.trim().toUpperCase() : "";
    const category = GENERAL_PRODUCT_CATEGORIES.find((item) => item.name.toLowerCase() === listing.category.toLowerCase().trim());
    const product = category?.productTypes.find((item) => item.name.toLowerCase() === listing.productType.toLowerCase().trim());
    // A clear holder can have gold hardware. Do not let "Transparent" hide an
    // explicitly named finish, or keep the previous product's fixed GLD code.
    const namedColor = listing.productName.match(/\b(multicolou?r|gold(?:en)?|silver|black|white|pink|blue|red|green|yellow)\b/i)?.[0]
        || listing.color.match(/\b(multicolou?r|gold(?:en)?|silver|black|white|pink|blue|red|green|yellow)\b/i)?.[0];
    return {
        brandCode: generalProductCode(listing.brandCode || "MBRO", "MBRO"),
        categoryCode: category?.code || generalProductCode(listing.category),
        productCode: product?.code || readCode(detected.productCode) || generalProductCode(listing.productType, "PROD"),
        colorCode: namedColor ? generalProductColorCode(namedColor)
            : readCode(detected.colorCode) || generalProductColorCode(listing.color || "Not specified"),
    };
}
export function createGeneralProductSku(codes, quantity, version = 1) {
    const count = Number(quantity);
    if (!Number.isInteger(count) || count < 1 || count > 9999)
        return "";
    if (!Number.isInteger(version) || version < 1)
        return "";
    return [
        generalProductCode(codes.brandCode, "BRAND"),
        generalProductCode(codes.categoryCode),
        generalProductCode(codes.productCode, "PROD"),
        generalProductCode(codes.colorCode, "NA"),
        `${count}PC`,
        `V${version}`,
    ].join("-");
}
export function normalizeGeneralProductSku(value) {
    return value.trim().replace(/(?:\.D)+$/i, "");
}
export function generalProductSkuError(value) {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(normalizeGeneralProductSku(value))
        ? "" : "Enter a SKU of 1–100 letters, numbers, hyphens, underscores or dots, starting with a letter or number.";
}
export function parseGeneralProductImageName(fileName) {
    const stem = fileName.split(/[\\/]/).at(-1)?.replace(/\.(png|jpe?g|webp)$/i, "").toUpperCase();
    const match = stem?.match(/^([A-Z0-9]+)-([A-Z0-9]+)-([A-Z0-9-]+)-([A-Z0-9]+)-(\d+)PC-V(\d+)(?:\.D)?$/);
    if (!match || Number(match[5]) < 1 || Number(match[5]) > 9999)
        return null;
    return {
        codes: {
            brandCode: match[1], categoryCode: match[2],
            productCode: match[3], colorCode: match[4],
        },
        quantity: String(Number(match[5])),
    };
}
export function selectionError(selections) {
    if (!selections.category.trim())
        return "Choose a category first.";
    if (!selections.genericName.trim())
        return "Choose a generic name first.";
    if (!selections.productType.trim())
        return "Choose a product type first.";
    const quantity = Number(selections.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
        return "Enter a pack quantity between 1 and 9999.";
    }
    return "";
}
export function selectedProductTitle(value, selections) {
    if (typeof value !== "string")
        return "";
    const title = value.replace(/[“”"']/g, "").replace(/\s+/g, " ").trim();
    const productType = selections.productType.toLowerCase().trim();
    const suffix = `(Pack of ${Number(selections.quantity)})`;
    if (title.length < 20 || title.length > 100 || !title.toLowerCase().includes(productType))
        return "";
    if (!title.endsWith(suffix))
        return "";
    // The same transparent patch can resemble a card holder. The seller's
    // selected product type determines its use, rather than that visual guess.
    if (/phone charms holder|lanyard insert tabs/i.test(productType) && /\b(id cards?|badge|name tag)\b/i.test(title))
        return "";
    const otherPackCounts = [...title.matchAll(/(?:pack of|set of)\s+(\d+)|(\d+)\s*(?:pcs|pieces)\b/gi)];
    if (otherPackCounts.some((match) => Number(match[1] || match[2]) !== Number(selections.quantity)))
        return "";
    return title;
}
