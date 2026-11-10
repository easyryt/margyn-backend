import { PDFDocument, StandardFonts } from "pdf-lib";
import { randomBytes } from "node:crypto";
export async function makeShippingPdf({ large = false, orders = true } = {}) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf
    .addPage([420, 595])
    .drawText("Instructions only", { x: 25, y: 550, size: 12, font });
  if (orders) {
    for (const [sku, order, product] of [
      ["MARGYN-BLUE-001", "123456789012345678_1", "Blue courier mailers"],
      ["MARGYN-BLUE-001", "123456789012345679_1", "Blue courier mailers"],
      ["MARGYN-KRAFT-002", "123456789012345680_1", "Kraft shipping boxes"],
    ]) {
      const page = pdf.addPage([420, 595]);
      [
        "Shipping label",
        "SKU Size Qty Color Order No.",
        sku + " Free Size 1 Blue " + order,
        "Description " + product,
        "Total Rs.100",
      ].forEach((line, index) =>
        page.drawText(line, { x: 25, y: 550 - index * 25, size: 10, font }),
      );
    }
  }
  if (large)
    await pdf.attach(randomBytes(11 * 1024 * 1024), "test-padding.bin");
  return Buffer.from(
    Uint8Array.from(await pdf.save({ useObjectStreams: false })).buffer,
  );
}
