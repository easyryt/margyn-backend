const Product = require('../models/Product');
const ProductDesign = require('../models/ProductDesign');
const Inventory = require('../models/Inventory');


// POST /api/product-designs
const createProductDesign = async (req, res) => {
  try {
    const {
      productId,
      name,
      mode,
      sku,
      designCode,
      rawQuantity = 0,
      minThreshold = 0,
      designUrl = '',
      notes = '',
    } = req.body;

    if (!productId || !name || !mode || !sku || !designCode) {
      return res.status(400).json({
        message: 'productId, name, mode, sku and designCode are required',
      });
    }

    if (Number(rawQuantity) < 0) {
      return res.status(400).json({
        message: 'rawQuantity cannot be negative',
      });
    }

    const product = await Product.findOne({
      _id: productId,
      isActive: true,
    });

    if (!product) {
      return res.status(400).json({
        message: 'Invalid or inactive product',
      });
    }

    const normalizedSku = String(sku).trim().toUpperCase();
    const normalizedDesignCode = String(designCode)
      .trim()
      .toUpperCase();

    // Check duplicate SKU
    const existingSku = await ProductDesign.findOne({
      sku: normalizedSku,
    });

    if (existingSku) {
      return res.status(409).json({
        message: 'This SKU already exists',
      });
    }

    // Check duplicate design code for this product
    const existingDesign = await ProductDesign.findOne({
      productId,
      designCode: normalizedDesignCode,
    });

    if (existingDesign) {
      return res.status(409).json({
        message: 'This design code already exists for the selected product',
      });
    }

    const design = await ProductDesign.create({
      productId,
      name,
      mode,
      sku: normalizedSku,
      designCode: normalizedDesignCode,
      designUrl,
      notes,
      isActive: true,
    });

    // Creates RAW inventory for this model/design.
    const rawInventory = await Inventory.findOneAndUpdate(
      {
        productId,
        type: 'RAW',
        designCode: design.designCode,
      },
      {
        $inc: {
          quantity: Number(rawQuantity),
        },

        $set: {
          isActive: true,
        },

        $setOnInsert: {
          productId,
          type: 'RAW',
          designCode: design.designCode,
          minThreshold: Number(minThreshold),
          barcodes: [],
        },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
      }
    );

    return res.status(201).json({
      message: 'Product model/design created successfully',
      design,
      rawInventory,
    });
  } catch (err) {
    console.error('Create product design error:', err);

    if (err.code === 11000) {
      return res.status(409).json({
        message: 'SKU or design code already exists',
      });
    }

    return res.status(500).json({
      message: 'Server error',
    });
  }
};


// GET /api/product-designs/product/:productId
const getProductDesigns = async (req, res) => {
  try {
    const { productId } = req.params;

    const designs = await ProductDesign.find({
      productId,
      isActive: true,
    }).sort({ name: 1 });

    return res.json({ designs });
  } catch (err) {
    console.error('Get product designs error:', err);

    return res.status(500).json({
      message: 'Server error',
    });
  }
};


// PUT /api/product-designs/:id
const updateProductDesign = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      name,
      mode,
      sku,
      designCode,
      designUrl,
      notes,
      isActive,
    } = req.body;

    const design = await ProductDesign.findById(id);

    if (!design) {
      return res.status(404).json({
        message: 'Product design not found',
      });
    }

    if (name !== undefined) {
      design.name = name;
    }

    if (mode !== undefined) {
      design.mode = mode;
    }

    if (sku !== undefined) {
      const normalizedSku = String(sku)
        .trim()
        .toUpperCase();

      // Check if SKU belongs to another design
      const existingSku = await ProductDesign.findOne({
        sku: normalizedSku,
        _id: { $ne: id },
      });

      if (existingSku) {
        return res.status(409).json({
          message: 'This SKU already exists',
        });
      }

      design.sku = normalizedSku;
    }

    if (designCode !== undefined) {
      design.designCode = String(designCode)
        .trim()
        .toUpperCase();
    }

    if (designUrl !== undefined) {
      design.designUrl = designUrl;
    }

    if (notes !== undefined) {
      design.notes = notes;
    }

    if (typeof isActive === 'boolean') {
      design.isActive = isActive;
    }

    await design.save();

    return res.json({
      message: 'Product design updated successfully',
      design,
    });
  } catch (err) {
    console.error('Update product design error:', err);

    if (err.code === 11000) {
      return res.status(409).json({
        message: 'SKU or design code already exists',
      });
    }

    return res.status(500).json({
      message: 'Server error',
    });
  }
};


// DELETE /api/product-designs/:id
const deleteProductDesign = async (req, res) => {
  try {
    const { id } = req.params;

    const design = await ProductDesign.findById(id);

    if (!design) {
      return res.status(404).json({
        message: 'Product design not found',
      });
    }

    design.isActive = false;

    await design.save();

    return res.json({
      message: 'Product design deactivated successfully',
    });
  } catch (err) {
    console.error('Delete product design error:', err);

    return res.status(500).json({
      message: 'Server error',
    });
  }
};


module.exports = {
  createProductDesign,
  getProductDesigns,
  updateProductDesign,
  deleteProductDesign,
};