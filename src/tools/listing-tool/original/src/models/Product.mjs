import mongoose from "../../../mongoose-context.mjs";

/*
|--------------------------------------------------------------------------
| Selected Phone Model
|--------------------------------------------------------------------------
*/

const selectedModelSchema = new mongoose.Schema(
  {
    model: {
      type: String,
      required: true,
      trim: true,
    }
  },
  {
    _id: false,
  },
);

/*
|--------------------------------------------------------------------------
| Product Schema
|--------------------------------------------------------------------------
*/

const productSchema = new mongoose.Schema(
  {
    /*
    |--------------------------------------------------------------------------
    | Basic Product Information
    |--------------------------------------------------------------------------
    */

    productName: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      default: "",
      trim: true,
    },

    brand: {
      type: String,
      default: "",
      trim: true,
    },

    category: {
      type: String,
      default: "",
      trim: true,
    },

    material: {
      type: String,
      default: "",
      trim: true,
    },

    color: {
      type: String,
      default: "",
      trim: true,
    },

    theme: {
      type: String,
      default: "",
      trim: true,
    },

    type: {
      type: String,
      default: "",
      trim: true,
    },

    /*
    |--------------------------------------------------------------------------
    | Pricing
    |--------------------------------------------------------------------------
    */

    price: {
      type: Number,
      default: 0,
      min: 0,
    },

    wrongDefectiveReturnsPrice: {
      type: Number,
      default: 2,
      min: 0,
      max: 30,
    },

    mrp: {
      type: Number,
      default: 0,
      min: 0,
    },

    gst: {
      type: Number,
      default: 0,
      min: 0,
    },

    hsn: {
      type: String,
      default: "",
      trim: true,
    },

    /*
    |--------------------------------------------------------------------------
    | Inventory
    |--------------------------------------------------------------------------
    */

    weight: {
      type: Number,
      default: 0,
      min: 0,
    },

    inventory: {
      type: Number,
      default: 0,
      min: 0,
    },

    /*
    |--------------------------------------------------------------------------
    | Country
    |--------------------------------------------------------------------------
    */

    country: {
      type: String,
      default: "",
      trim: true,
    },

    /*
    |--------------------------------------------------------------------------
    | Manufacturer
    |--------------------------------------------------------------------------
    */

    manufacturer: {
      type: String,
      default: "",
      trim: true,
    },

    manufacturerAddress: {
      type: String,
      default: "",
      trim: true,
    },

    manufacturerPincode: {
      type: String,
      default: "",
      trim: true,
    },

    /*
    |--------------------------------------------------------------------------
    | Packer
    |--------------------------------------------------------------------------
    */

    packer: {
      type: String,
      default: "",
      trim: true,
    },

    packerAddress: {
      type: String,
      default: "",
      trim: true,
    },

    packerPincode: {
      type: String,
      default: "",
      trim: true,
    },

    /*
    |--------------------------------------------------------------------------
    | Importer
    |--------------------------------------------------------------------------
    */

    importer: {
      type: String,
      default: "",
      trim: true,
    },

    importerAddress: {
      type: String,
      default: "",
      trim: true,
    },

    importerPincode: {
      type: String,
      default: "",
      trim: true,
    },

    /*
    |--------------------------------------------------------------------------
    | Generic Information
    |--------------------------------------------------------------------------
    */

    genericName: {
      type: String,
      default: "",
      trim: true,
    },

    size: {
      type: String,
      default: "",
      trim: true,
    },

    quantity: {
      type: Number,
      default: 1,
      min: 0,
    },

    length: {
      type: Number,
      default: 0,
      min: 0,
    },

    width: {
      type: Number,
      default: 0,
      min: 0,
    },

    /*
    |--------------------------------------------------------------------------
    | Design Information
    |--------------------------------------------------------------------------
    */

    designId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Design",
      default: undefined,
    },

    designName: {
      type: String,
      default: undefined,
      trim: true,
    },

    designCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },

    /*
    |--------------------------------------------------------------------------
    | Design Number
    |
    | Parent products get unique numbers:
    |
    | 317
    | 318
    | 319
    |
    | Variants reuse the parent's designNumber.
    |--------------------------------------------------------------------------
    */

    designNumber: {
      type: String,
      required: true,
      trim: true,
    },

    /*
    |--------------------------------------------------------------------------
    | SKU
    |
    | SKU is unique for EVERY product and variant.
    |--------------------------------------------------------------------------
    */

    sku: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },

    styleId: {
      type: String,
      default: undefined,
      trim: true,
      uppercase: true,
    },

    /*
    |--------------------------------------------------------------------------
    | Print / Finish / Version
    |--------------------------------------------------------------------------
    */

    printType: {
      type: String,
      default: "",
      trim: true,
    },

    finish: {
      type: String,
      default: "",
      trim: true,
    },

    version: {
      type: String,
      default: "1",
      trim: true,
    },

    /*
    |--------------------------------------------------------------------------
    | Images
    |--------------------------------------------------------------------------
    */

    image1: {
      type: String,
      default: "",
      trim: true,
    },

    image2: {
      type: String,
      default: "",
      trim: true,
    },

    image3: {
      type: String,
      default: "",
      trim: true,
    },

    image4: {
      type: String,
      default: "",
      trim: true,
    },

    /*
    |--------------------------------------------------------------------------
    | Group
    |--------------------------------------------------------------------------
    */

    groupId: {
      type: String,
      default: undefined,
      trim: true,
    },

    /*
    |--------------------------------------------------------------------------
    | Phone Models
    |--------------------------------------------------------------------------
    */

    models: {
      type: [selectedModelSchema],
      default: undefined,

      validate: {
        validator(models) {
          return (
            models === undefined ||
            (
              Array.isArray(models) &&
              models.length > 0
            )
          );
        },

        message:
          "At least one phone model is required.",
      },
    },

    /*
    |--------------------------------------------------------------------------
    | Parent Product
    |--------------------------------------------------------------------------
    */

    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: undefined,
    },

    /*
    |--------------------------------------------------------------------------
    | Variant Number
    |--------------------------------------------------------------------------
    */

    variantNumber: {
      type: Number,
      min: 2,
      default: undefined,
    },

    /*
    |--------------------------------------------------------------------------
    | Variant Type
    |
    | Identifies special variants (such as with-charms products) so the
    | frontend can display them in their own section for a design.
    |--------------------------------------------------------------------------
    */

    variantType: {
      type: String,
      enum: [
        "standard",
        "charm",
      ],
      default: "standard",
      trim: true,
      lowercase: true,
    },
  },

  {
    timestamps: true,

    /*
    |--------------------------------------------------------------------------
    | Reject unknown properties
    |--------------------------------------------------------------------------
    */

    strict: "throw",
  },
);

/*
|--------------------------------------------------------------------------
| Normal Indexes
|--------------------------------------------------------------------------
*/

productSchema.index({
  createdAt: -1,
});

productSchema.index({
  productName: 1,
});

productSchema.index({
  designCode: 1,
});

productSchema.index({
  category: 1,
});

productSchema.index({
  brand: 1,
});

productSchema.index({
  inventory: 1,
});

productSchema.index({
  parentId: 1,
});

productSchema.index({
  groupId: 1,
});

productSchema.index({
  "models.model": 1,
});

productSchema.index(
  {
    designNumber: 1,
  },
  {
    name:
      "product_design_number_lookup",
  },
);

productSchema.index({
  designId: 1,
});

/*
|--------------------------------------------------------------------------
| GLOBALLY UNIQUE SKU
|--------------------------------------------------------------------------
|
| Parent V1:
|   SKU-A ✅
|
| Variant V2:
|   SKU-B ✅
|
| Duplicate SKU:
|   SKU-A ❌
|
|--------------------------------------------------------------------------
*/

productSchema.index(
  {
    sku: 1,
  },
  {
    unique: true,

    /*
    | Existing legacy records without SKU
    | won't collide while migrating.
    */
    sparse: true,

    name:
      "unique_product_sku",
  },
);

/*
|--------------------------------------------------------------------------
| MODEL
|--------------------------------------------------------------------------
*/

const Product =
  mongoose.models.Product ||
  mongoose.model(
    "Product",
    productSchema,
  );

export default Product;
