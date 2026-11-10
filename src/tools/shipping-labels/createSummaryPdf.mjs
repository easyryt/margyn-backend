// Ported from the supplied shipping-labels-tool. See provenance.json.
import { PDFDocument, StandardFonts, rgb, } from "pdf-lib";
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const HEADER_HEIGHT = 55;
const FOOTER_HEIGHT = 45;
const DEFAULT_ROW_HEIGHT = 24;
const COLORS = {
    primary: rgb(0.13, 0.45, 0.88),
    primaryDark: rgb(0.08, 0.33, 0.72),
    white: rgb(1, 1, 1),
    border: rgb(0.84, 0.86, 0.90),
    light: rgb(0.97, 0.98, 1),
    gray: rgb(0.45, 0.45, 0.45),
    text: rgb(0.12, 0.12, 0.12),
};
export async function createSummaryPdf(grouped) {
    const pdfDoc = await PDFDocument.create();
    const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const totalProducts = Object.keys(grouped).length;
    const totalOrders = Object.values(grouped).reduce((sum, rows) => sum + rows.length, 0);
    let currentPage;
    let currentY = 0;
    let pageNumber = 0;
    //---------------------------------------------------------
    // Draw Text
    //---------------------------------------------------------
    const drawText = (text, x, y, size = 10, isBold = false, color = COLORS.text) => {
        currentPage.drawText(text, {
            x,
            y,
            size,
            font: isBold ? bold : regular,
            color,
        });
    };
    //---------------------------------------------------------
    // Draw Rectangle
    //---------------------------------------------------------
    const drawRect = (x, y, width, height, color = COLORS.white, border = true) => {
        currentPage.drawRectangle({
            x,
            y,
            width,
            height,
            color,
            borderColor: COLORS.border,
            borderWidth: border ? 1 : 0,
        });
    };
    //---------------------------------------------------------
    // Center Text
    //---------------------------------------------------------
    const drawCentered = (text, left, width, y, size = 10, isBold = false, color = COLORS.text) => {
        const font = isBold ? bold : regular;
        const textWidth = font.widthOfTextAtSize(text, size);
        currentPage.drawText(text, {
            x: left + (width - textWidth) / 2,
            y,
            size,
            font,
            color,
        });
    };
    //---------------------------------------------------------
    // Word Wrap
    //---------------------------------------------------------
    function wrapText(text, font, size, maxWidth) {
        const words = text.split(" ");
        const lines = [];
        let line = "";
        for (const word of words) {
            const test = line ? line + " " + word : word;
            const width = font.widthOfTextAtSize(test, size);
            if (width <= maxWidth) {
                line = test;
            }
            else {
                if (line)
                    lines.push(line);
                line = word;
            }
        }
        if (line) {
            lines.push(line);
        }
        return lines;
    }
    //---------------------------------------------------------
    // Row Height
    //---------------------------------------------------------
    function getRowHeight(text, font, fontSize, width) {
        const lines = wrapText(text, font, fontSize, width);
        return Math.max(DEFAULT_ROW_HEIGHT, lines.length * 13 + 10);
    }
    //---------------------------------------------------------
    // New Page
    //---------------------------------------------------------
    function addPage() {
        currentPage = pdfDoc.addPage([
            PAGE_WIDTH,
            PAGE_HEIGHT,
        ]);
        pageNumber++;
        currentY = PAGE_HEIGHT - MARGIN;
    }
    //---------------------------------------------------------
    // Table Configuration
    //---------------------------------------------------------
    const columns = {
        sr: 45,
        sku: 395,
        qty: 75,
    };
    const tableX = MARGIN;
    //---------------------------------------------------------
    // Draw Table Header
    //---------------------------------------------------------
    function drawTableHeader() {
        let x = tableX;
        const headerY = currentY;
        const drawHeaderCell = (text, width, align = "left") => {
            drawRect(x, headerY - DEFAULT_ROW_HEIGHT, width, DEFAULT_ROW_HEIGHT, COLORS.primary, false);
            if (align === "center") {
                drawCentered(text, x, width, headerY - 17, 10, true, COLORS.white);
            }
            else {
                drawText(text, x + 8, headerY - 17, 10, true, COLORS.white);
            }
            currentPage.drawRectangle({
                x,
                y: headerY - DEFAULT_ROW_HEIGHT,
                width,
                height: DEFAULT_ROW_HEIGHT,
                borderColor: COLORS.border,
                borderWidth: 1,
            });
            x += width;
        };
        drawHeaderCell("Sr.", columns.sr, "center");
        drawHeaderCell("SKU", columns.sku);
        drawHeaderCell("Qty", columns.qty, "center");
        currentY -= DEFAULT_ROW_HEIGHT;
    }
    //---------------------------------------------------------
    // Summary Header
    //---------------------------------------------------------
    function drawPageHeader(isFirstPage = false) {
        if (isFirstPage) {
            drawRect(MARGIN, currentY - HEADER_HEIGHT, CONTENT_WIDTH, HEADER_HEIGHT, COLORS.primary, false);
            drawCentered("ORDER SUMMARY", MARGIN, CONTENT_WIDTH, currentY - 35, 24, true, COLORS.white);
            currentY -= HEADER_HEIGHT + 22;
            //-------------------------------------------------
            // Summary Cards
            //-------------------------------------------------
            const cards = [
                {
                    title: "Generated",
                    value: new Date().toLocaleDateString() +
                        " " +
                        new Date().toLocaleTimeString(),
                },
                {
                    title: "Products",
                    value: totalProducts.toString(),
                },
                {
                    title: "Orders",
                    value: totalOrders.toString(),
                },
            ];
            const cardWidth = 150;
            const cardHeight = 58;
            const gap = 12;
            cards.forEach((card, index) => {
                const x = MARGIN +
                    index * (cardWidth + gap);
                drawRect(x, currentY - cardHeight, cardWidth, cardHeight, COLORS.light);
                drawText(card.title, x + 10, currentY - 18, 9, false, COLORS.gray);
                drawText(card.value, x + 10, currentY - 40, 13, true);
            });
            currentY -= 82;
        }
        drawTableHeader();
    }
    //---------------------------------------------------------
    // Page Break Handler
    //---------------------------------------------------------
    function ensureSpace(requiredHeight) {
        if (currentY - requiredHeight <
            FOOTER_HEIGHT + 35) {
            addPage();
            drawPageHeader(false);
        }
    }
    //---------------------------------------------------------
    // Create First Page
    //---------------------------------------------------------
    addPage();
    drawPageHeader(true);
    //---------------------------------------------------------
    // Start Table
    //---------------------------------------------------------
    let sr = 1;
    let rowIndex = 0;
    //---------------------------------------------------------
    // Draw Table Rows (Multi Page)
    //---------------------------------------------------------
    for (const [sku, orders] of Object.entries(grouped)) {
        rowIndex++;
        const fontSize = 9;
        const wrappedLines = wrapText(sku.replace(/-+$/g, ""), regular, fontSize, columns.sku - 16);
        const rowHeight = Math.max(DEFAULT_ROW_HEIGHT, wrappedLines.length * 13 + 10);
        ensureSpace(rowHeight);
        const background = rowIndex % 2 === 0
            ? COLORS.light
            : COLORS.white;
        let x = tableX;
        //-----------------------------------------------------
        // SR
        //-----------------------------------------------------
        drawRect(x, currentY - rowHeight, columns.sr, rowHeight, background);
        drawCentered(sr.toString(), x, columns.sr, currentY - rowHeight / 2 - 4, 10);
        x += columns.sr;
        //-----------------------------------------------------
        // SKU
        //-----------------------------------------------------
        drawRect(x, currentY - rowHeight, columns.sku, rowHeight, background);
        let lineY = currentY - 15;
        wrappedLines.forEach((line) => {
            drawText(line, x + 8, lineY, fontSize);
            lineY -= 13;
        });
        x += columns.sku;
        //-----------------------------------------------------
        // Quantity
        //-----------------------------------------------------
        drawRect(x, currentY - rowHeight, columns.qty, rowHeight, background);
        drawCentered(orders.length.toString(), x, columns.qty, currentY - rowHeight / 2 - 4, 10, true);
        //-----------------------------------------------------
        // Next Row
        //-----------------------------------------------------
        currentY -= rowHeight;
        sr++;
    }
    //---------------------------------------------------------
    // Space before Total
    //---------------------------------------------------------
    ensureSpace(DEFAULT_ROW_HEIGHT + 15);
    //---------------------------------------------------------
    // TOTAL ROW
    //---------------------------------------------------------
    const totalHeight = DEFAULT_ROW_HEIGHT + 4;
    drawRect(tableX, currentY - totalHeight, columns.sr + columns.sku, totalHeight, COLORS.primaryDark, false);
    drawText("TOTAL ORDERS", tableX + 12, currentY - 18, 11, true, COLORS.white);
    drawRect(tableX + columns.sr + columns.sku, currentY - totalHeight, columns.qty, totalHeight, COLORS.primaryDark, false);
    drawCentered(totalOrders.toString(), tableX + columns.sr + columns.sku, columns.qty, currentY - totalHeight / 2 - 4, 11, true, COLORS.white);
    currentY -= totalHeight + 18;
    //---------------------------------------------------------
    // FOOTER
    //---------------------------------------------------------
    function drawFooter(page, pageNo, totalPages) {
        const footerY = 22;
        page.drawLine({
            start: {
                x: MARGIN,
                y: FOOTER_HEIGHT,
            },
            end: {
                x: PAGE_WIDTH - MARGIN,
                y: FOOTER_HEIGHT,
            },
            thickness: 0.8,
            color: COLORS.border,
        });
        page.drawText("Generated by PDF Sorter", {
            x: MARGIN,
            y: footerY,
            size: 9,
            font: regular,
            color: COLORS.gray,
        });
        const pageText = `Page ${pageNo} of ${totalPages}`;
        const width = regular.widthOfTextAtSize(pageText, 9);
        page.drawText(pageText, {
            x: PAGE_WIDTH - MARGIN - width,
            y: footerY,
            size: 9,
            font: regular,
            color: COLORS.gray,
        });
    }
    //---------------------------------------------------------
    // DRAW FOOTER ON EVERY PAGE
    //---------------------------------------------------------
    const pages = pdfDoc.getPages();
    pages.forEach((page, index) => {
        drawFooter(page, index + 1, pages.length);
    });
    //---------------------------------------------------------
    // SAVE PDF
    //---------------------------------------------------------
    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
}
