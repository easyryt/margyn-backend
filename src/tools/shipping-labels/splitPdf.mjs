// Ported from the supplied shipping-labels-tool. See provenance.json.
import { PDFDocument } from "pdf-lib";
function safeFileName(name) {
    return name
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/\s+/g, " ")
        .replace(/\.+$/, "")
        .trim();
}
export async function splitPdfByGroups(originalPdf, grouped) {
    const sourcePdf = await PDFDocument.load(originalPdf);
    const totalPages = sourcePdf.getPageCount();
    const files = {};
    for (const [groupName, orders] of Object.entries(grouped)) {
        if (!orders.length) {
            continue;
        }
        //----------------------------------
        // Remove duplicate pages
        //----------------------------------
        const pageIndexes = [
            ...new Set(orders
                .map((o) => o.pageNumber - 1)
                .filter((page) => page >= 0 &&
                page < totalPages)),
        ];
        if (!pageIndexes.length) {
            continue;
        }
        //----------------------------------
        // Create PDF
        //----------------------------------
        const pdf = await PDFDocument.create();
        const copied = await pdf.copyPages(sourcePdf, pageIndexes);
        for (const page of copied) {
            pdf.addPage(page);
        }
        //----------------------------------
        // Save
        //----------------------------------
        const bytes = await pdf.save({
            useObjectStreams: false,
            addDefaultPage: false,
        });
        files[safeFileName(groupName)] = bytes;
    }
    return files;
}
