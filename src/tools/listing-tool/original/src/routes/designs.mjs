import express from "express";
import mongoose from "../../../mongoose-context.mjs";

import Design from "../models/Design.mjs";
import Product from "../models/Product.mjs";

const router = express.Router();

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCode(value) {
  return clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 32);
}

function escapeRegex(value) {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
}

function serializeDesign(
  design,
  usage = {},
) {
  return {
    id: design._id.toString(),
    designName: design.designName,
    designCode: design.designCode,
    imageUrl: design.imageUrl || "",
    thumbnailUrl:
      design.thumbnailUrl ||
      design.imageUrl ||
      "",
    imageFileId:
      design.imageFileId || "",
    imageFilePath:
      design.imageFilePath || "",
    imageFileName:
      design.imageFileName || "",
    imageMimeType:
      design.imageMimeType || "",
    source: design.source,
    referenceCount:
      design.references?.length || 0,
    references:
      design.references || [],
    category:
      clean(design.category) ||
      clean(usage.sampleCategory),
    theme:
      clean(design.theme) ||
      clean(usage.sampleTheme),
    productType:
      clean(design.productType) ||
      clean(usage.sampleProductType),
    usageCount:
      Number(usage.usageCount || 0),
    sampleTitle:
      clean(usage.sampleTitle),
    sampleModel:
      clean(usage.sampleModel),
    createdAt: design.createdAt,
    updatedAt: design.updatedAt,
  };
}

router.get(
  "/",
  async (request, response, next) => {
    try {
      const search =
        clean(request.query.search);
      const limit = Math.min(
        Math.max(
          Number(request.query.limit) || 100,
          1,
        ),
        250,
      );

      const filter = search
        ? {
            $or: [
              {
                designName: {
                  $regex:
                    escapeRegex(search),
                  $options: "i",
                },
              },
              {
                designCode: {
                  $regex:
                    escapeRegex(search),
                  $options: "i",
                },
              },
            ],
          }
        : {};

      const designs =
        await Design.find(filter)
          .sort({ createdAt: -1 })
          .limit(limit)
          .lean();

      const designIds =
        designs.map(
          (design) =>
            design._id,
        );

      const usageRows = designIds.length
        ? await Product.aggregate([
            {
              $match: {
                parentId: {
                  $exists: false,
                },
                designId: {
                  $in: designIds,
                },
              },
            },
            {
              $sort: {
                createdAt: -1,
              },
            },
            {
              $group: {
                _id: "$designId",
                count: {
                  $sum: 1,
                },
                sampleTitle: {
                  $first: "$productName",
                },
                sampleModel: {
                  $first: {
                    $arrayElemAt: [
                      "$models.model",
                      0,
                    ],
                  },
                },
                sampleCategory: {
                  $first: "$category",
                },
                sampleTheme: {
                  $first: "$theme",
                },
                sampleProductType: {
                  $first: "$type",
                },
              },
            },
          ])
        : [];

      const usageById = new Map(
        usageRows.map((row) => [
          row._id.toString(),
          {
            usageCount:
              Number(row.count || 0),
            sampleTitle:
              clean(row.sampleTitle),
            sampleModel:
              clean(row.sampleModel),
            sampleCategory:
              clean(row.sampleCategory),
            sampleTheme:
              clean(row.sampleTheme),
            sampleProductType:
              clean(row.sampleProductType),
          },
        ]),
      );

      response.json({
        success: true,
        count: designs.length,
        designs: designs.map(
          (design) =>
            serializeDesign(
              design,
              usageById.get(
                design._id.toString(),
              ) || {},
            ),
        ),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/:id",
  async (request, response, next) => {
    try {
      if (
        !mongoose.isObjectIdOrHexString(
          request.params.id,
        )
      ) {
        throw httpError(
          400,
          "Invalid design ID.",
        );
      }

      const design =
        await Design.findById(
          request.params.id,
        ).lean();

      if (!design) {
        throw httpError(
          404,
          "Design not found.",
        );
      }

      const [usageCount, sampleProduct] =
        await Promise.all([
          Product.countDocuments({
            parentId: {
              $exists: false,
            },
            designId: design._id,
          }),
          Product.findOne({
            parentId: {
              $exists: false,
            },
            designId: design._id,
          })
            .sort({ createdAt: -1 })
            .select(
              "productName models category theme type",
            )
            .lean(),
        ]);

      response.json({
        success: true,
        design:
          serializeDesign(
            design,
            {
              usageCount,
              sampleTitle:
                sampleProduct?.productName,
              sampleModel:
                sampleProduct?.models?.[0]?.model,
              sampleCategory:
                sampleProduct?.category,
              sampleTheme:
                sampleProduct?.theme,
              sampleProductType:
                sampleProduct?.type,
            },
          ),
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/",
  async (request, response, next) => {
    try {
      const designName =
        clean(request.body?.designName);
      const designCode =
        cleanCode(request.body?.designCode);
      const category =
        clean(request.body?.category);
      const theme =
        clean(request.body?.theme);
      const productType =
        clean(request.body?.productType);

      if (!designName) {
        throw httpError(
          400,
          "Design Name is required.",
        );
      }

      if (
        designName.length < 2 ||
        designName.length > 120
      ) {
        throw httpError(
          400,
          "Design Name must contain 2 to 120 characters.",
        );
      }

      if (!/^[A-Z0-9]{3,32}$/.test(designCode)) {
        throw httpError(
          400,
          "Design Code must contain 3 to 32 uppercase letters or numbers.",
        );
      }

      const existingByCode =
        await Design.findOne({
          designCode,
        });

      if (existingByCode) {
        if (
          existingByCode.designName
            .toLowerCase() !==
          designName.toLowerCase()
        ) {
          throw httpError(
            409,
            "This Design Code belongs to another saved design.",
          );
        }

        let existingChanged = false;

        if (
          !existingByCode.imageUrl &&
          clean(request.body?.imageUrl)
        ) {
          existingByCode.imageUrl =
            clean(request.body.imageUrl);
          existingByCode.thumbnailUrl =
            clean(
              request.body.thumbnailUrl,
            );
          existingByCode.imageFileId =
            clean(
              request.body.imageFileId,
            );
          existingByCode.imageFilePath =
            clean(
              request.body.imageFilePath,
            );
          existingByCode.imageFileName =
            clean(
              request.body.imageFileName,
            );
          existingByCode.imageMimeType =
            clean(
              request.body.imageMimeType,
            );
          existingChanged = true;
        }

        for (const [field, value] of [
          ["category", category],
          ["theme", theme],
          ["productType", productType],
        ]) {
          if (!existingByCode[field] && value) {
            existingByCode[field] = value;
            existingChanged = true;
          }
        }

        if (existingChanged) {
          await existingByCode.save();
        }

        return response.json({
          success: true,
          created: false,
          design:
            serializeDesign(
              existingByCode,
            ),
        });
      }

      const existingByName =
        await Design.findOne({
          designName: {
            $regex:
              `^${escapeRegex(designName)}$`,
            $options: "i",
          },
        }).lean();

      if (existingByName) {
        throw httpError(
          409,
          "This Design Name already exists with another code.",
        );
      }

      let created;

      try {
        created = await Design.create({
          designName,
          designCode,
          category,
          theme,
          productType,
          imageUrl:
            clean(
              request.body?.imageUrl,
            ),
          thumbnailUrl:
            clean(
              request.body?.thumbnailUrl,
            ),
          imageFileId:
            clean(
              request.body?.imageFileId,
            ),
          imageFilePath:
            clean(
              request.body?.imageFilePath,
            ),
          imageFileName:
            clean(
              request.body?.imageFileName,
            ),
          imageMimeType:
            clean(
              request.body?.imageMimeType,
            ),
          source:
            ["ai", "legacy", "manual"].includes(
              request.body?.source,
            )
              ? request.body.source
              : "manual",
        });
      } catch (error) {
        if (error?.code === 11000) {
          throw httpError(
            409,
            "This Design Name or Design Code is already saved.",
          );
        }

        throw error;
      }

      response.status(201).json({
        success: true,
        created: true,
        design:
          serializeDesign(created),
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
