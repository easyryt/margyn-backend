export const MEESHO_PANEL = "https://supplier.meesho.com/panel/v3/new/cataloging/jifdb/images-bulk-upload";
export function meeshoTargetKey(target) { return JSON.stringify([target.rowId, target.field]); }
export function validMeeshoTarget(value) {
    if (!value || typeof value !== "object")
        return false;
    const t = value;
    return typeof t.rowId === "string" && t.rowId.length > 0 && t.rowId.length <= 200 && !/[\x00-\x1f]/.test(t.rowId)
        && ["image1", "image2", "image3", "image4"].includes(t.field);
}
export function isMeeshoPanel(value) {
    try {
        const u = new URL(value);
        return u.origin === "https://supplier.meesho.com" && !u.username && !u.password && !u.search && !u.hash && /^\/panel\/v3\/new\/cataloging\/[\w-]+\/images-bulk-upload$/.test(u.pathname);
    }
    catch {
        return false;
    }
}
export function matchingMeeshoReceipt(receipt, expected) {
    if (!receipt || receipt.id !== expected.id || receipt.sha256 !== expected.sha256 || receipt.filename !== expected.filename
        || !validMeeshoTarget(receipt.target) || meeshoTargetKey(receipt.target) !== meeshoTargetKey(expected.target))
        return false;
    try {
        const u = new URL(receipt.url);
        return u.origin === "https://upload.meeshosupplyassets.com" && !u.username && !u.password && !u.search && !u.hash
            && /^\/cataloging\/\d+\/[\w.-]+\.(png|jpg)$/.test(u.pathname) && u.pathname.split("/").pop() === expected.filename;
    }
    catch {
        return false;
    }
}
export function canApplyMeeshoReceipt(receipt, expected, currentValue, initialValue) {
    return matchingMeeshoReceipt(receipt, expected) && (currentValue === initialValue || currentValue === receipt.url);
}
