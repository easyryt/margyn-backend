// Ported from the supplied shipping-labels-tool. See provenance.json.
import PDFParser from "pdf2json";
import fs from "fs/promises";
function decodeText(text) {
    if (!text)
        return "";
    try {
        return decodeURIComponent(text.replace(/\+/g, "%20"));
    }
    catch {
        return text;
    }
}
function normalizeText(text) {
    return text
        .replace(/\r/g, "")
        .replace(/\u0000/g, "")
        .replace(/\uFFFE/g, "")
        .replace(/\uFFFF/g, "")
        .replace(/\t/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function extractPageText(page) {
    if (!page?.Texts)
        return "";
    let result = "";
    for (const block of page.Texts) {
        if (!block?.R)
            continue;
        for (const run of block.R) {
            result += decodeText(run?.T ?? "");
        }
        result += " ";
    }
    return normalizeText(result);
}
/**
 * Read PDF from Buffer (current compatibility)
 */
export async function readPdf(buffer) {
    return new Promise((resolve, reject) => {
        const parser = new PDFParser(undefined, true);
        parser.on("pdfParser_dataError", (err) => {
            reject(new Error(err?.parserError ??
                "Failed to parse PDF."));
        });
        parser.on("pdfParser_dataReady", (pdfData) => {
            try {
                const pdfPages = pdfData?.Pages ?? [];
                const pages = [];
                for (let i = 0; i < pdfPages.length; i++) {
                    pages.push({
                        pageNumber: i + 1,
                        text: extractPageText(pdfPages[i]),
                    });
                }
                resolve(pages);
            }
            catch (error) {
                reject(error);
            }
        });
        parser.parseBuffer(buffer);
    });
}
/**
 * Read PDF directly from file
 * (used in the next phase)
 */
export async function readPdfFromFile(filePath) {
    await fs.access(filePath);
    return new Promise((resolve, reject) => {
        const parser = new PDFParser(undefined, true);
        parser.on("pdfParser_dataError", (err) => {
            reject(new Error(err?.parserError ??
                "Failed to parse PDF."));
        });
        parser.on("pdfParser_dataReady", (pdfData) => {
            try {
                const pdfPages = pdfData?.Pages ?? [];
                const pages = [];
                for (let i = 0; i < pdfPages.length; i++) {
                    pages.push({
                        pageNumber: i + 1,
                        text: extractPageText(pdfPages[i]),
                    });
                }
                resolve(pages);
            }
            catch (error) {
                reject(error);
            }
        });
        parser.loadPDF(filePath);
    });
}
