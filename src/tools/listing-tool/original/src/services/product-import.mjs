/*
|--------------------------------------------------------------------------
| Product spreadsheet import helpers
|
| These functions are intentionally database-free so SKU parsing, header
| detection, blank-cell behavior, and parent/variant grouping can be tested
| without starting Express or connecting to MongoDB.
|--------------------------------------------------------------------------
*/

const STRING_COLUMNS = [
  ["description", ["product description", "description"]],
  ["brand", ["brand name", "brand"]],
  ["material", ["material"]],
  ["color", ["color"]],
  ["theme", ["theme"]],
  ["type", ["type"]],
  ["hsn", ["hsn id", "hsn"]],
  ["country", ["country of origin", "country"]],
  ["manufacturer", ["manufacturer name", "manufacturer"]],
  ["manufacturerAddress", ["manufacturer address"]],
  ["manufacturerPincode", ["manufacturer pincode"]],
  ["packer", ["packer name", "packer"]],
  ["packerAddress", ["packer address"]],
  ["packerPincode", ["packer pincode"]],
  ["importer", ["importer name", "importer"]],
  ["importerAddress", ["importer address"]],
  ["importerPincode", ["importer pincode"]],
  ["genericName", ["generic name"]],
  ["size", ["variation", "size"]],
  ["styleId", ["product id / style id", "style id", "product id"]],
  ["image1", ["image 1 (front)", "image 1"]],
  ["image2", ["image 2"]],
  ["image3", ["image 3"]],
  ["image4", ["image 4"]],
  ["groupId", ["group id"]],
];

const NUMBER_COLUMNS = [
  ["price", ["meesho price", "price"]],
  ["mrp", ["mrp"]],
  ["gst", ["gst %", "gst"]],
  ["weight", ["net weight (gms)", "weight"]],
  ["inventory", ["inventory", "stock"]],
  ["quantity", ["net quantity (n)", "quantity"]],
  ["length", ["product length (cm)", "length"]],
  ["width", ["product width(cm)", "product width (cm)", "width"]],
];

const WRONG_DEFECTIVE_RETURN_PRICE_COLUMNS = [
  "wrong/defective returns price",
  "wrong defective returns price",
  "wrong/defective return price",
  "wrong defective return price",
];

const WRONG_DEFECTIVE_RETURN_DISCOUNT_COLUMNS = [
  "wrong/defective return discount",
  "wrong defective return discount",
  "wrong/defective returns discount",
  "wrong defective returns discount",
  "wrong/defective return discount(₹)",
  "wrong defective return discount(₹)",
  "wrong/defective returns discount(₹)",
  "wrong defective returns discount(₹)",
];

const DEFAULT_WRONG_DEFECTIVE_RETURN_DISCOUNT = 2;

export function cleanImportHeader(value) {
  return String(value ?? "")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function headerMatches(header, name) {
  const normalized = cleanImportHeader(header);

  return normalized === name || normalized.startsWith(`${name} `);
}

export function findImportColumn(headers, names) {
  for (const name of names) {
    const index = headers.findIndex((header) => headerMatches(header, name));
    if (index >= 0) return index;
  }

  return -1;
}

function importCell(row, headers, names) {
  const checkedColumns = new Set();

  for (const name of names) {
    for (let index = 0; index < headers.length; index += 1) {
      if (checkedColumns.has(index) || !headerMatches(headers[index], name)) {
        continue;
      }

      checkedColumns.add(index);
      const value = row[index];

      if (value !== undefined && value !== null && String(value).trim() !== "") {
        return String(value).trim();
      }
    }
  }

  return undefined;
}

function importNumber(row, headers, names) {
  const rawValue = importCell(row, headers, names);
  if (rawValue === undefined) return undefined;

  const value = Number(
    rawValue
      .replace(/[₹,%\s]/g, "")
      .replace(/,/g, ""),
  );

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid number: ${rawValue}`);
  }

  return value;
}

function validateWrongDefectiveReturnDiscount(value) {
  if (value > 30) {
    throw new Error(
      "Wrong/Defective Return Discount must be between ₹0 and ₹30.",
    );
  }

  return value;
}

function importWrongDefectiveReturnDiscount(row, headers, meeshoPrice) {
  const hasDiscountColumn =
    findImportColumn(headers, WRONG_DEFECTIVE_RETURN_DISCOUNT_COLUMNS) >= 0;
  const hasLegacyPriceColumn =
    findImportColumn(headers, WRONG_DEFECTIVE_RETURN_PRICE_COLUMNS) >= 0;

  if (!hasDiscountColumn && !hasLegacyPriceColumn) {
    return { hasColumn: false };
  }

  if (hasDiscountColumn) {
    const discount = importNumber(
      row,
      headers,
      WRONG_DEFECTIVE_RETURN_DISCOUNT_COLUMNS,
    );

    if (discount !== undefined) {
      return {
        hasColumn: true,
        value: validateWrongDefectiveReturnDiscount(discount),
      };
    }
  }

  if (hasLegacyPriceColumn) {
    const returnPrice = importNumber(
      row,
      headers,
      WRONG_DEFECTIVE_RETURN_PRICE_COLUMNS,
    );

    if (returnPrice !== undefined) {
      // Recent exports used the legacy header while already writing a discount.
      if (returnPrice <= 30) {
        return { hasColumn: true, value: returnPrice };
      }

      if (meeshoPrice === undefined) {
        throw new Error(
          "Meesho Price is required to calculate the Wrong/Defective Return Discount.",
        );
      }

      const discount = Math.round((meeshoPrice - returnPrice) * 100) / 100;

      if (discount < 0) {
        throw new Error(
          "Wrong/Defective Returns Price cannot be greater than Meesho Price.",
        );
      }

      return {
        hasColumn: true,
        value: validateWrongDefectiveReturnDiscount(discount),
      };
    }
  }

  return {
    hasColumn: true,
    value: DEFAULT_WRONG_DEFECTIVE_RETURN_DISCOUNT,
  };
}

export function parseListingSku(value) {
  const sku = String(value ?? "").trim().toUpperCase();

  if (!sku) {
    throw new Error("SKU ID is required.");
  }

  const versionMatch = sku.match(
    /-(\d+)(?:\.(\d+))?\.V(\d+)$/i,
  );

  if (!versionMatch) {
    throw new Error(
      `SKU "${sku}" must end with a design number and version, for example -268.1.V1.`,
    );
  }

  const parts = sku.split("-");
  const printType = parts.at(-5);
  const designCode = parts.at(-4);
  const finish = parts.at(-3);

  if (
    !printType ||
    !designCode ||
    !finish ||
    !/^[A-Z0-9]+$/i.test(printType) ||
    !/^[A-Z0-9]+$/i.test(designCode) ||
    !/^[A-Z0-9]+$/i.test(finish)
  ) {
    throw new Error(
      `SKU "${sku}" must contain Print Type, Design Code, and Finish before its color and version.`,
    );
  }

  const version = Number(versionMatch[3]);

  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`SKU "${sku}" contains an invalid version.`);
  }

  return {
    sku,
    printType: printType.toUpperCase(),
    designCode: designCode.toUpperCase(),
    finish: finish.toUpperCase(),
    designNumber: versionMatch[1],
    designRevision: versionMatch[2] || "",
    familyKey: sku.replace(/\.V\d+$/i, ""),
    version,
  };
}

export function parseDesignReferenceSku(value) {
  const rawSku = String(value ?? "").trim().toUpperCase();

  if (!rawSku) {
    throw new Error("Design reference SKU is required.");
  }

  const versionedSku = /\.V\d+$/i.test(rawSku)
    ? rawSku
    : `${rawSku}.V1`;
  const parsed = parseListingSku(versionedSku);

  return {
    ...parsed,
    skuFamily: parsed.familyKey,
  };
}

export function mapImportRow(row, headers, rowNumber) {
  const productName = importCell(row, headers, ["product name", "title"]);
  const hasSkuColumn =
    findImportColumn(headers, ["sku id", "seller sku id", "sku"]) >= 0;
  const skuValue = hasSkuColumn
    ? importCell(row, headers, ["sku id", "seller sku id", "sku"])
    : importCell(row, headers, [
        "product id / style id",
        "style id",
        "product id",
      ]);

  if (!productName) {
    throw new Error("Product Name is required.");
  }

  const sku = parseListingSku(skuValue);
  const clearFields = [];
  const data = {
    productName,
    printType: sku.printType,
    designCode: sku.designCode,
    finish: sku.finish,
    designNumber: sku.designNumber,
    sku: sku.sku,
    version: String(sku.version),
  };

  for (const [field, names] of STRING_COLUMNS) {
    if (findImportColumn(headers, names) < 0) continue;

    const value = importCell(row, headers, names);
    if (value !== undefined) {
      data[field] = value;
    } else {
      clearFields.push(field);
    }
  }

  for (const [field, names] of NUMBER_COLUMNS) {
    if (findImportColumn(headers, names) < 0) continue;

    const value = importNumber(row, headers, names);
    if (value !== undefined) {
      data[field] = value;
    } else {
      clearFields.push(field);
    }
  }

  const returnDiscount = importWrongDefectiveReturnDiscount(
    row,
    headers,
    data.price,
  );

  if (returnDiscount.hasColumn) {
    if (returnDiscount.value !== undefined) {
      data.wrongDefectiveReturnsPrice = returnDiscount.value;
    } else {
      clearFields.push("wrongDefectiveReturnsPrice");
    }
  }

  const hasGenericNameColumn =
    findImportColumn(headers, ["generic name"]) >= 0;

  if (hasGenericNameColumn) {
    if (data.genericName) {
      data.category = data.genericName;
      const categoryIndex = clearFields.indexOf("category");
      if (categoryIndex >= 0) clearFields.splice(categoryIndex, 1);
    } else {
      delete data.category;
      clearFields.push("category");
    }
  }

  const hasManufacturerColumn =
    findImportColumn(headers, ["manufacturer name", "manufacturer"]) >= 0;

  if (hasManufacturerColumn) {
    if (data.manufacturer) {
      data.brand = data.manufacturer;
      const brandIndex = clearFields.indexOf("brand");
      if (brandIndex >= 0) clearFields.splice(brandIndex, 1);
    } else {
      delete data.brand;
      clearFields.push("brand");
    }
  }

  const compatibleModels = importCell(row, headers, [
    "compatible models",
    "compatible model",
    "phone model",
  ]);

  if (compatibleModels !== undefined) {
    data.models = [{ model: compatibleModels }];
  } else if (
    findImportColumn(headers, [
      "compatible models",
      "compatible model",
      "phone model",
    ]) >= 0
  ) {
    clearFields.push("models");
  }

  /* Do not trust a free-text Design Name in a product sheet. The import route
     resolves it from the saved design library using this row's SKU code. */
  delete data.designName;
  clearFields.push("designName");

  return {
    data,
    clearFields: [...new Set(clearFields)],
    familyKey: sku.familyKey,
    version: sku.version,
    rowNumber,
  };
}

function isIgnoredSheet(sheetName) {
  return /instruction|example|validation|return reason/i.test(sheetName);
}

function isDesignReferenceSheet(sheetName) {
  return /design[\s_-]*(name|master|lookup|mapping|library)/i.test(
    String(sheetName ?? ""),
  );
}

function findDesignReferenceSkuIndex(row) {
  return row.findIndex((value) => {
    const candidate = String(value ?? "").trim();

    return (
      candidate.split("-").length >= 6 &&
      /-\d+(?:\.\d+)?(?:\.V\d+)?$/i.test(candidate)
    );
  });
}

export function parseWorkbookDesignReferences(workbook, sheetToRows) {
  const byCode = new Map();
  const errors = [];
  let supportedSheetCount = 0;
  let referenceRowCount = 0;

  for (const sheetName of workbook.SheetNames) {
    if (!isDesignReferenceSheet(sheetName)) continue;

    supportedSheetCount += 1;
    const rows = sheetToRows(workbook.Sheets[sheetName]);

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const skuIndex = findDesignReferenceSkuIndex(row);

      if (skuIndex < 0) continue;

      try {
        const sku = parseDesignReferenceSku(row[skuIndex]);
        const designName = String(row[skuIndex - 3] ?? "")
          .replace(/\s+/g, " ")
          .trim();

        if (!designName) {
          throw new Error("Design Name is required for this reference SKU.");
        }

        referenceRowCount += 1;
        const reference = {
          designNumber:
            String(row[skuIndex - 4] ?? "").trim() || sku.designNumber,
          model: String(row[skuIndex - 2] ?? "").trim(),
          collection: String(row[skuIndex - 1] ?? "").trim(),
          skuFamily: sku.skuFamily,
          printType: sku.printType,
          finish: sku.finish,
          sourceSheet: sheetName,
          sourceRow: index + 1,
        };
        const current = byCode.get(sku.designCode);

        if (
          current &&
          current.designName.toLocaleLowerCase() !==
            designName.toLocaleLowerCase()
        ) {
          errors.push({
            sheet: sheetName,
            row: index + 1,
            message:
              `Design Code ${sku.designCode} is mapped to both ` +
              `"${current.designName}" and "${designName}".`,
          });
          continue;
        }

        if (!current) {
          byCode.set(sku.designCode, {
            designCode: sku.designCode,
            designName,
            references: [reference],
            sheet: sheetName,
            rowNumber: index + 1,
          });
          continue;
        }

        if (
          !current.references.some(
            (item) => item.skuFamily === reference.skuFamily,
          )
        ) {
          current.references.push(reference);
        }
      } catch (error) {
        errors.push({
          sheet: sheetName,
          row: index + 1,
          message: error.message || "Could not read this design reference.",
        });
      }
    }
  }

  return {
    mappings: [...byCode.values()],
    errors,
    supportedSheetCount,
    referenceRowCount,
  };
}

function rowContainsProductData(row, headers) {
  return Boolean(
    importCell(row, headers, ["product name", "title"]) ||
      importCell(row, headers, ["sku id", "seller sku id", "sku"]),
  );
}

function isTutorialRow(row) {
  return row.some((value) =>
    /^(tutorial link|watch explainer video)$/i.test(
      String(value ?? "").trim(),
    ),
  );
}

export function parseWorkbookProducts(workbook, sheetToRows) {
  const items = [];
  const errors = [];
  let supportedSheetCount = 0;

  for (const sheetName of workbook.SheetNames) {
    if (isIgnoredSheet(sheetName)) continue;

    const rows = sheetToRows(workbook.Sheets[sheetName]);
    const headerRowIndex = rows.findIndex(
      (row) => findImportColumn(row, ["product name", "title"]) >= 0,
    );

    if (headerRowIndex < 0) continue;
    supportedSheetCount += 1;

    const headers = rows[headerRowIndex];

    for (let index = headerRowIndex + 1; index < rows.length; index += 1) {
      const row = rows[index];
      const productName = importCell(row, headers, ["product name", "title"]);

      if (isTutorialRow(row)) continue;
      if (!rowContainsProductData(row, headers)) continue;

      try {
        items.push({
          ...mapImportRow(row, headers, index + 1),
          sheet: sheetName,
        });
      } catch (error) {
        errors.push({
          sheet: sheetName,
          row: index + 1,
          message: error.message || "Could not read this row.",
        });
      }
    }
  }

  return {
    items,
    errors,
    supportedSheetCount,
  };
}

export function organizeImportGroups(items) {
  const byFamily = new Map();

  for (const item of items) {
    const key = item.familyKey;
    if (!byFamily.has(key)) byFamily.set(key, []);
    byFamily.get(key).push(item);
  }

  const groups = [];
  const errors = [];

  for (const [familyKey, groupItems] of byFamily) {
    const designNumber = groupItems[0].data.designNumber;
    const versions = new Map();
    const codes = new Set(groupItems.map((item) => item.data.designCode));

    for (const item of groupItems) {
      if (!versions.has(item.version)) versions.set(item.version, []);
      versions.get(item.version).push(item);
    }

    let groupError = "";

    if (codes.size !== 1) {
      groupError = `Design ${designNumber} contains different design codes.`;
    } else if ((versions.get(1) || []).length !== 1) {
      groupError = `Design ${designNumber} must contain exactly one V1 parent row.`;
    } else {
      const duplicateVersion = [...versions.entries()].find(
        ([, versionItems]) => versionItems.length > 1,
      );

      if (duplicateVersion) {
        groupError = `Design ${designNumber} contains duplicate V${duplicateVersion[0]} rows.`;
      }
    }

    if (groupError) {
      for (const item of groupItems) {
        errors.push({
          sheet: item.sheet,
          row: item.rowNumber,
          message: groupError,
        });
      }
      continue;
    }

    groups.push({
      familyKey,
      designNumber,
      parent: versions.get(1)[0],
      variants: groupItems
        .filter((item) => item.version > 1)
        .sort((first, second) => first.version - second.version),
    });
  }

  return {
    groups,
    errors,
  };
}
