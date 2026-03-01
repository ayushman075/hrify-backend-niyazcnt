import mongoose from "mongoose";

const divisionSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Division name is required"],
      trim: true,
    },
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      required: [true, "Parent Department is required"]
    },
    description: {
      type: String,
      trim: true
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    }
  },
  {
    timestamps: true
  }
);

// Compound index: A division name must be unique WITHIN a specific department
divisionSchema.index({ name: 1, department: 1 }, { unique: true });

export const Division = mongoose.model("Division", divisionSchema);