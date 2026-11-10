const mongoose = require('../../../mongoose-context.cjs');

const packingSessionSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: true, // e.g. 2026-07-07
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('PackingSession', packingSessionSchema);