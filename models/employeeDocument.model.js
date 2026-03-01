import mongoose from "mongoose";

const employeeDocumentSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: [true, "Employee reference is required"],
      index: true, // Fast lookups for an employee's vault
    },
    documentType: {
      type: String,
      enum: [
        "ID Proof", 
        "Address Proof", 
        "Educational Certificate", 
        "Offer Letter", 
        "Relieving Letter", 
        "Experience Letter",
        "Payslip",
        "Medical Record",
        "Other"
      ],
      required: [true, "Document type is required"],
    },
    title: {
      type: String,
      required: [true, "Document title is required"],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    fileUrl: {
      type: String,
      required: [true, "File URL is required"],
    },
    publicId: {
      type: String,
      required: [true, "Cloudinary Public ID is required for deletion"],
      select: false, // Hide from standard queries by default for security
    },
    fileFormat: {
      type: String, // e.g., 'pdf', 'jpg', 'png'
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// Compound index for efficient filtering by employee and doc type
employeeDocumentSchema.index({ employee: 1, documentType: 1 });

export const EmployeeDocument = mongoose.model("EmployeeDocument", employeeDocumentSchema);