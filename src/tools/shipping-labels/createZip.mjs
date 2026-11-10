// Ported from the supplied shipping-labels-tool. See provenance.json.
import { ZipFile } from "yazl";
export async function createZip(summaryPdf, pdfFiles) {
    return new Promise((resolve, reject) => {
        const zip = new ZipFile();
        const chunks = [];
        zip.outputStream.on("data", (chunk) => {
            chunks.push(chunk);
        });
        zip.outputStream.on("error", reject);
        zip.outputStream.on("end", () => {
            resolve(Buffer.concat(chunks));
        });
        // Summary
        zip.addBuffer(Buffer.from(summaryPdf), "Summary.pdf");
        // Sort filenames
        const names = Object.keys(pdfFiles).sort();
        for (const name of names) {
            zip.addBuffer(Buffer.from(pdfFiles[name]), `${name}.pdf`);
        }
        zip.end();
    });
}
