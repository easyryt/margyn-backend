
const Category = require('../models/Category');
const Product = require('../models/Product');

// Validate attributes against category.metaFields
const validateAttributes = (category, attributes) => {
  const errors = [];

  // Check required fields
  category.metaFields.forEach((field) => {
    const value = attributes[field.key];

    if (
      field.required &&
      (value === undefined || value === null || value === '')
    ) {
      errors.push(`Missing required attribute: ${field.key}`);
      return;
    }

    if (value === undefined || value === null) return;

    if (field.type === 'number' && typeof value !== 'number') {
      errors.push(`Attribute ${field.key} must be a number`);
    }

    if (field.type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`Attribute ${field.key} must be a boolean`);
    }

    if (field.type === 'string' && typeof value !== 'string') {
      errors.push(`Attribute ${field.key} must be a string`);
    }
  });

  // Check extra attributes
  Object.keys(attributes).forEach((key) => {
    const exists = category.metaFields.some(
      (field) => field.key === key
    );

    if (!exists) {
      errors.push(
        `Unknown attribute key for this category: ${key}`
      );
    }
  });

  return errors;
};


// POST /api/products
const createProduct = async (req, res) => {
  try {
    const { categoryId, name, attributes } = req.body;

    const category = await Category.findById(categoryId);

    if (!category || !category.isActive) {
      return res.status(400).json({
        message: 'Invalid or inactive category',
      });
    }

    const errors = validateAttributes(
      category,
      attributes || {}
    );

    if (errors.length > 0) {
      return res.status(400).json({
        message: 'Invalid attributes',
        errors,
      });
    }

    const product = await Product.create({
      categoryId,
      name,
      attributes,
    });

    return res.status(201).json({
      message: 'Product created successfully',
      product,
    });
  } catch (err) {
    console.error('Create product error', err);

    return res.status(500).json({
      message: 'Server error',
    });
  }
};


// GET /api/products
const getProducts = async (req, res) => {
  try {
    const products = await Product.find({
      isActive: true,
    })
      .populate('categoryId', 'name metaFields')
      .sort({ createdAt: -1 });

    return res.json({
      products,
    });
  } catch (err) {
    console.error('Get products error', err);

    return res.status(500).json({
      message: 'Server error',
    });
  }
};


// GET /api/products/:id
const getProductById = async (req, res) => {
  try {
    const { id } = req.params;

    const product = await Product.findById(id).populate(
      'categoryId',
      'name metaFields'
    );

    if (!product) {
      return res.status(404).json({
        message: 'Product not found',
      });
    }

    return res.json({
      product,
    });
  } catch (err) {
    console.error('Get product by id error', err);

    return res.status(500).json({
      message: 'Server error',
    });
  }
};


// PUT /api/products/:id
const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, attributes, isActive } = req.body;

    const product = await Product.findById(id).populate(
      'categoryId'
    );

    if (!product) {
      return res.status(404).json({
        message: 'Product not found',
      });
    }

    if (attributes !== undefined) {
      const errors = validateAttributes(
        product.categoryId,
        attributes
      );

      if (errors.length > 0) {
        return res.status(400).json({
          message: 'Invalid attributes',
          errors,
        });
      }

      product.attributes = attributes;
    }

    if (name !== undefined) {
      product.name = name;
    }

    if (typeof isActive === 'boolean') {
      product.isActive = isActive;
    }

    await product.save();

    return res.json({
      message: 'Product updated successfully',
      product,
    });
  } catch (err) {
    console.error('Update product error', err);

    return res.status(500).json({
      message: 'Server error',
    });
  }
};


// DELETE /api/products/:id
// Soft delete product without triggering full document validation.
// This avoids errors for older products that may not have attributes.
const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;

    const product = await Product.findByIdAndUpdate(
      id,
      {
        $set: {
          isActive: false,
        },
      },
      {
        new: true,
        runValidators: false,
      }
    );

    if (!product) {
      return res.status(404).json({
        message: 'Product not found',
      });
    }

    return res.json({
      message: 'Product deactivated successfully',
      product,
    });
  } catch (err) {
    console.error('Delete product error', err);

    return res.status(500).json({
      message: 'Server error',
    });
  }
};


module.exports = {
  createProduct,
  getProducts,
  getProductById,
  updateProduct,
  deleteProduct,
};

