import mongoose from 'mongoose';

const thresholdSchema = new mongoose.Schema({
  type: { type: String, enum: ['underworked', 'overworked'], required: true },
  minDifference: { type: Number, required: true },
  maxDifference: { type: Number, required: true },
  percentageAdjustment: { type: Number, required: true },
});

const matricesSchema = new mongoose.Schema({
  name: { type: String, required: true }, 
  thresholds: [thresholdSchema],  
});

const Matrices = mongoose.model('Matrices', matricesSchema);

export default Matrices;
