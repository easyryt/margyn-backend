// Reused from the supplied image-generator project. See provenance.json.
export const CHARM_VIEW_IDS = ["hand-closeup", "charm-product-flatlay", "charm-only"];
export function isCharmViewId(value) {
    return value === "hand-closeup" || value === "charm-product-flatlay" || value === "charm-only";
}
