import assert from "node:assert/strict";
import test from "node:test";

import {
  mapImportRow,
  organizeImportGroups,
  parseDesignReferenceSku,
  parseListingSku,
  parseWorkbookDesignReferences,
  parseWorkbookProducts,
} from "../../src/tools/listing-tool/original/src/services/product-import.mjs";

const HEADERS = [
  "Product Name",
  "Meesho Price",
  "MRP",
  "Inventory",
  "Compatible Models",
  "Product ID / Style ID",
  "SKU ID",
  "Group ID",
  "Product Description",
  "Wrong/Defective Returns Price",
  "Manufacturer Name",
  "Generic Name",
];

function listingRow({
  name = "iPhone 11 clear cover",
  sku = "MBRO-MC-AP-IP11-UVV-CUTPNRBCT-WL-TRNSPT-268.1.V1",
  price = "113",
  mrp = "899",
  inventory = "2000",
  model = "Apple iPhone 11",
  group = "Group 01",
  description = "",
  wrongDefectiveReturnsPrice = "112",
  manufacturer = "Mobiro",
  genericName = "Mobile Cases & Covers",
} = {}) {
  return [
    name,
    price,
    mrp,
    inventory,
    model,
    sku,
    sku,
    group,
    description,
    wrongDefectiveReturnsPrice,
    manufacturer,
    genericName,
  ];
}

test("extracts design metadata from the listing SKU", () => {
  assert.deepEqual(
    parseListingSku(
      "MBRO-MC-AP-IP11-UVV-CUTPNRBCT-WL-TRNSPT-268.1.V8",
    ),
    {
      sku: "MBRO-MC-AP-IP11-UVV-CUTPNRBCT-WL-TRNSPT-268.1.V8",
      printType: "UVV",
      designCode: "CUTPNRBCT",
      finish: "WL",
      designNumber: "268",
      designRevision: "1",
      familyKey: "MBRO-MC-AP-IP11-UVV-CUTPNRBCT-WL-TRNSPT-268.1",
      version: 8,
    },
  );
});

test("extracts a design code from a versionless reference SKU", () => {
  const parsed = parseDesignReferenceSku(
    "MBRO-MC-AP-IP11-UVV-CUTPNRBCT-WL-TRNSPT-268.1",
  );

  assert.equal(parsed.designCode, "CUTPNRBCT");
  assert.equal(parsed.printType, "UVV");
  assert.equal(parsed.finish, "WL");
  assert.equal(
    parsed.skuFamily,
    "MBRO-MC-AP-IP11-UVV-CUTPNRBCT-WL-TRNSPT-268.1",
  );
});

test("keeps the complete long design code used by Pink Bow Floral Blossom", () => {
  const parsed = parseListingSku(
    "MBRO-MC-AP-IP11-UVV-PNKBWFLRBLSM-WL-TRNSPT-275.1.V1",
  );

  assert.equal(parsed.designCode, "PNKBWFLRBLSM");
  assert.equal(parsed.printType, "UVV");
  assert.equal(parsed.finish, "WL");
});

test("builds a reusable design library from a design-name sheet", () => {
  const workbook = {
    SheetNames: ["Sheet1", "design name"],
    Sheets: {
      Sheet1: [["Category"], ["Mobile Cover"]],
      "design name": [
        [
          "268",
          "Cute Pink Ribbon Cat",
          "Iphone 11",
          "Mobiro New Design",
          "MBRO-MC-AP-IP11-UVV-CUTPNRBCT-WL-TRNSPT-268.1",
        ],
        [
          "276",
          "Cute Pink Ribbon Cat",
          "Iphone 12",
          "Mobiro New Design",
          "MBRO-MC-AP-IP12-UVV-CUTPNRBCT-WL-TRNSPT-276.1",
        ],
      ],
    },
  };
  const parsed = parseWorkbookDesignReferences(
    workbook,
    (sheet) => sheet,
  );

  assert.equal(parsed.supportedSheetCount, 1);
  assert.equal(parsed.referenceRowCount, 2);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.mappings.length, 1);
  assert.equal(parsed.mappings[0].designCode, "CUTPNRBCT");
  assert.equal(parsed.mappings[0].designName, "Cute Pink Ribbon Cat");
  assert.equal(parsed.mappings[0].references.length, 2);
});

test("maps only populated spreadsheet cells", () => {
  const mapped = mapImportRow(
    listingRow({
      description: "",
      inventory: "0",
    }),
    HEADERS,
    5,
  );

  assert.equal(mapped.data.designCode, "CUTPNRBCT");
  assert.equal(mapped.data.printType, "UVV");
  assert.equal(mapped.data.finish, "WL");
  assert.equal(mapped.data.designNumber, "268");
  assert.equal(mapped.data.version, "1");
  assert.equal(mapped.data.inventory, 0);
  assert.equal(mapped.data.models[0].model, "Apple iPhone 11");
  assert.equal(mapped.data.genericName, "Mobile Cases & Covers");
  assert.equal(mapped.data.category, "Mobile Cases & Covers");
  assert.equal(mapped.data.manufacturer, "Mobiro");
  assert.equal(mapped.data.brand, "Mobiro");
  assert.equal(mapped.data.wrongDefectiveReturnsPrice, 1);
  assert.equal(mapped.data.styleId, mapped.data.sku);
  assert.equal(Object.hasOwn(mapped.data, "description"), false);
  assert.equal(Object.hasOwn(mapped.data, "designName"), false);
  assert.equal(mapped.clearFields.includes("description"), true);
  assert.equal(mapped.clearFields.includes("designName"), true);
});

test("keeps a current direct return discount under the legacy heading", () => {
  const mapped = mapImportRow(
    listingRow({
      price: "191",
      wrongDefectiveReturnsPrice: "2",
    }),
    HEADERS,
    5,
  );

  assert.equal(mapped.data.wrongDefectiveReturnsPrice, 2);
});

test("imports the current return discount heading directly", () => {
  const headers = [
    "Product Name",
    "Meesho Price",
    "SKU ID",
    "Wrong/Defective Return Discount(₹)",
  ];
  const mapped = mapImportRow(
    [
      "Current cover",
      "191",
      "MBRO-MC-AP-IP11-UVV-CUTPNRBCT-WL-TRNSPT-268.1.V1",
      "2",
    ],
    headers,
    5,
  );

  assert.equal(mapped.data.wrongDefectiveReturnsPrice, 2);
});

test("uses the default discount when the return value is blank", () => {
  const mapped = mapImportRow(
    listingRow({ wrongDefectiveReturnsPrice: "" }),
    HEADERS,
    5,
  );

  assert.equal(mapped.data.wrongDefectiveReturnsPrice, 2);
  assert.equal(
    mapped.clearFields.includes("wrongDefectiveReturnsPrice"),
    false,
  );
});

test("rejects an invalid legacy return price difference", () => {
  assert.throws(
    () =>
      mapImportRow(
        listingRow({
          price: "113",
          wrongDefectiveReturnsPrice: "80",
        }),
        HEADERS,
        5,
      ),
    /discount must be between ₹0 and ₹30/i,
  );
});

test("rejects a legacy return price above the Meesho price", () => {
  assert.throws(
    () =>
      mapImportRow(
        listingRow({
          price: "113",
          wrongDefectiveReturnsPrice: "114",
        }),
        HEADERS,
        5,
      ),
    /cannot be greater than Meesho Price/i,
  );
});

test("preserves a workbook model containing a comma as one exact option", () => {
  const headers = ["Product Name", "SKU ID", "Compatible Models"];
  const mapped = mapImportRow(
    [
      "Legacy cover",
      "MBRO-MC-RDM-A4-UVV-DESIGN-WL-TRNSPT-999.1.V1",
      "Redmi a4,Huawei y5",
    ],
    headers,
    2,
  );

  assert.deepEqual(mapped.data.models, [
    { model: "Redmi a4,Huawei y5" },
  ]);
});

test("preserves fields whose columns do not exist in a legacy workbook", () => {
  const headers = ["Product Name", "SKU ID"];
  const mapped = mapImportRow(
    [
      "Legacy cover",
      "MBRO-MC-AP-IP11-UVV-CUTPNRBCT-WL-TRNSPT-268.1.V1",
    ],
    headers,
    2,
  );

  assert.equal(mapped.clearFields.includes("description"), false);
  assert.equal(mapped.clearFields.includes("inventory"), false);
  assert.equal(mapped.clearFields.includes("designName"), true);
});

test("waits for the SKU design-library lookup instead of trusting free text", () => {
  const headers = ["Product Name", "Design Name", "SKU ID"];
  const mapped = mapImportRow(
    [
      "Named cover",
      "Cute Pink Ribbon Cat",
      "MBRO-MC-AP-IP11-UVV-CUTPNRBCT-WL-TRNSPT-268.1.V1",
    ],
    headers,
    2,
  );

  assert.equal(Object.hasOwn(mapped.data, "designName"), false);
  assert.equal(mapped.clearFields.includes("designName"), true);
});

test("organizes V1 as parent and later versions as ordered variants", () => {
  const items = [8, 1, 3, 2].map((version) => ({
    ...mapImportRow(
      listingRow({
        sku: `MBRO-MC-AP-IP11-UVV-CUTPNRBCT-WL-TRNSPT-268.1.V${version}`,
        group: `Group ${version}`,
      }),
      HEADERS,
      version + 4,
    ),
    sheet: "Fill this",
  }));
  const organized = organizeImportGroups(items);

  assert.equal(organized.errors.length, 0);
  assert.equal(organized.groups.length, 1);
  assert.equal(organized.groups[0].parent.version, 1);
  assert.deepEqual(
    organized.groups[0].variants.map((variant) => variant.version),
    [2, 3, 8],
  );
});

test("rejects a design group that has no V1 parent", () => {
  const item = {
    ...mapImportRow(
      listingRow({
        sku: "MBRO-MC-AP-IP11-UVV-CUTPNRBCT-WL-TRNSPT-268.1.V2",
      }),
      HEADERS,
      6,
    ),
    sheet: "Fill this",
  };
  const organized = organizeImportGroups([item]);

  assert.equal(organized.groups.length, 0);
  assert.match(organized.errors[0].message, /exactly one V1 parent/i);
});

test("keeps different SKU family revisions in separate groups", () => {
  const items = ["1", "2"].map((revision, index) => ({
    ...mapImportRow(
      listingRow({
        sku: `MBRO-MC-AP-IP11-UVV-CUTPNRBCT-WL-TRNSPT-268.${revision}.V1`,
      }),
      HEADERS,
      index + 5,
    ),
    sheet: "Fill this",
  }));
  const organized = organizeImportGroups(items);

  assert.equal(organized.errors.length, 0);
  assert.equal(organized.groups.length, 2);
});

test("ignores instruction and example sheets", () => {
  const workbook = {
    SheetNames: ["Instructions", "Mobile-Cases---Covers-Fill this", "Example Sheet"],
    Sheets: {
      Instructions: "instructions",
      "Mobile-Cases---Covers-Fill this": "data",
      "Example Sheet": "example",
    },
  };
  const rowsBySheet = {
    instructions: [["Product Name"], ["Do not import"]],
    data: [
      HEADERS,
      [
        "",
        "",
        "",
        "",
        "",
        "Watch Explainer Video",
        "Watch Explainer Video",
        "",
        "",
      ],
      listingRow(),
    ],
    example: [HEADERS, listingRow({ name: "Example product" })],
  };
  const parsed = parseWorkbookProducts(
    workbook,
    (sheet) => rowsBySheet[sheet],
  );

  assert.equal(parsed.supportedSheetCount, 1);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].data.productName, "iPhone 11 clear cover");
});
