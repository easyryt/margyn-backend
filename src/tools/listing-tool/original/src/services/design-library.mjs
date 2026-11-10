import Design from "../models/Design.mjs";
import Product from "../models/Product.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

export async function initializeDesignLibrary() {
  const productIndexes =
    await Product.collection.indexes();

  const legacyUniqueIndexes =
    productIndexes.filter(
      (index) =>
        index.unique === true &&
        index.key?.designNumber === 1 &&
        Object.keys(index.key).length === 1,
    );

  for (const index of legacyUniqueIndexes) {
    await Product.collection.dropIndex(
      index.name,
    );

    console.log(
      `Removed legacy unique product design index: ${index.name}`,
    );
  }

  const currentIndexes =
    await Product.collection.indexes();

  if (
    !currentIndexes.some(
      (index) =>
        index.key?.designNumber === 1 &&
        Object.keys(index.key).length === 1,
    )
  ) {
    await Product.collection.createIndex(
      { designNumber: 1 },
      { name: "product_design_number_lookup" },
    );
  }

  if (
    !currentIndexes.some(
      (index) =>
        index.key?.designId === 1 &&
        Object.keys(index.key).length === 1,
    )
  ) {
    await Product.collection.createIndex(
      { designId: 1 },
      { name: "product_design_id_lookup" },
    );
  }

  let designIndexes = [];

  try {
    designIndexes =
      await Design.collection.indexes();
  } catch (error) {
    if (error?.code !== 26) {
      throw error;
    }
  }

  const obsoleteDesignIndexes =
    designIndexes.filter(
      (index) =>
        (index.key?.designNumber === 1 &&
          Object.keys(index.key).length === 1) ||
        (index.key?.designName === 1 &&
          Object.keys(index.key).length === 1 &&
          index.unique !== true),
    );

  for (const index of obsoleteDesignIndexes) {
    try {
      await Design.collection.dropIndex(
        index.name,
      );
    } catch (error) {
      if (error?.code !== 27) {
        throw error;
      }
    }

    console.log(
      `Removed obsolete design-library index: ${index.name}`,
    );
  }

  await Design.collection.updateMany(
    {
      designNumber: {
        $exists: true,
      },
    },
    {
      $unset: {
        designNumber: "",
      },
    },
  );

  await Design.createIndexes();

  const parents =
    await Product.find({
      parentId: {
        $exists: false,
      },
      designName: {
        $exists: true,
        $nin: ["", null],
      },
      designCode: {
        $exists: true,
        $nin: ["", null],
      },
    })
      .select(
        "designId designName designCode image1",
      )
      .lean();

  for (const parent of parents) {
    const designName =
      clean(parent.designName);
    const designCode =
      clean(parent.designCode).toUpperCase();
    let design =
      await Design.findOne({
        designCode,
      }).lean();

    if (
      design &&
      design.designName.toLowerCase() !==
        designName.toLowerCase()
    ) {
      console.warn(
        `Skipped conflicting legacy design ${designCode}.`,
      );
      continue;
    }

    if (!design) {
      try {
        design =
          (
            await Design.create({
              designName,
              designCode,
              imageUrl:
                clean(parent.image1),
              source: "legacy",
            })
          ).toObject();
      } catch (error) {
        if (error?.code !== 11000) {
          throw error;
        }

        design =
          await Design.findOne({
            $or: [
              { designCode },
              {
                designName: {
                  $regex: `^${designName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
                  $options: "i",
                },
              },
            ],
          }).lean();
      }
    }

    if (!design?._id) {
      continue;
    }

    await Product.updateMany(
      {
        designCode,
      },
      {
        $set: {
          designId:
            design._id,
        },
      },
    );
  }

  console.log(
    `Design library ready: ${await Design.countDocuments()} saved design(s).`,
  );
}
