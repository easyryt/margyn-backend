const Category = require('../models/Category');

// POST /api/categories  (ADMIN only)
const createCategory = async (req, res) => {
  try {
    const { name, metaFields } = req.body;

    const existing = await Category.findOne({ name });
    if (existing) {
      return res.status(409).json({ message: 'Category name already exists' });
    }

    const category = await Category.create({
      name,
      metaFields: metaFields || [],
    });

    res.status(201).json({
      message: 'Category created successfully',
      category,
    });
  } catch (err) {
    console.error('Create category error', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// GET /api/categories  (list all)
const getCategories = async (req, res) => {
  try {
    const categories = await Category.find({ isActive: true }).sort({ createdAt: -1 });

    res.json({ categories });
  } catch (err) {
    console.error('Get categories error', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// GET /api/categories/:id
const getCategoryById = async (req, res) => {
  try {
    const { id } = req.params;
    const category = await Category.findById(id);

    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }

    res.json({ category });
  } catch (err) {
    console.error('Get category by id error', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// PUT /api/categories/:id  (ADMIN only)
const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, metaFields, isActive } = req.body;

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }

    if (name) category.name = name;
    if (Array.isArray(metaFields)) category.metaFields = metaFields;
    if (typeof isActive === 'boolean') category.isActive = isActive;

    await category.save();

    res.json({
      message: 'Category updated successfully',
      category,
    });
  } catch (err) {
    console.error('Update category error', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// DELETE /api/categories/:id  (ADMIN only — soft delete recommended)
const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }

    category.isActive = false;
    await category.save();

    res.json({ message: 'Category deactivated successfully' });
  } catch (err) {
    console.error('Delete category error', err);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = {
  createCategory,
  getCategories,
  getCategoryById,
  updateCategory,
  deleteCategory,
};