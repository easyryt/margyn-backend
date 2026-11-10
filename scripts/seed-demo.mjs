import { saveProduct } from "../src/services/store.mjs";
export async function seedDemo() {
  const items = [
    [
      "Meesho non-transparent POD courier bag with pocket",
      "DEMO-MS-001",
      "Courier bags",
      "/products/mailer.svg",
      2.53,
      50,
    ],
    [
      "Meesho transparent courier bag without pocket",
      "DEMO-MS-002",
      "Courier bags",
      "/products/mailer.svg",
      2.84,
      100,
    ],
    [
      "Flipkart non-transparent courier bag",
      "DEMO-FK-003",
      "Courier bags",
      "/products/black-mailer.svg",
      4.98,
      50,
    ],
    [
      "Flipkart transparent courier bag without pocket",
      "DEMO-FK-004",
      "Courier bags",
      "/products/mailer.svg",
      3.59,
      100,
    ],
    [
      "3-ply kraft shipping boxes",
      "DEMO-BX-005",
      "Shipping boxes",
      "/products/box.svg",
      19.2,
      25,
    ],
    [
      "4 × 6 thermal label rolls",
      "DEMO-LB-006",
      "Labels & stickers",
      "/products/labels.svg",
      0.6,
      400,
    ],
  ];
  const products = [];
  for (const [name, sku, category, image, price, packSize] of items)
    products.push(
      await saveProduct({
        name,
        sku,
        category,
        image,
        images: [image],
        price,
        compareAt: 0,
        unit: "piece",
        packSize,
        minOrder: 1,
        stock: 200,
        sizes: ["6X8", "8X10", "10X14"],
        vendor: "Sample vendor",
        verified: false,
        specification: "51–60 Micron",
        description:
          "Sample packaging product for development and testing. Replace this example with accurate product information before publishing.",
        status: "published",
        featured: true,
        gstRate: 18,
        dispatchDays: 2,
        shipsFrom: "India",
        tiers: [
          { minCartons: 1, price },
          { minCartons: 2, price: Math.round(price * 0.95 * 100) / 100 },
          { minCartons: 10, price: Math.round(price * 0.9 * 100) / 100 },
          { minCartons: 20, price: Math.round(price * 0.85 * 100) / 100 },
        ],
      }),
    );
  return products;
}
