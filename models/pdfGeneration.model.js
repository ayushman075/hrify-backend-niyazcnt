import mongoose from "mongoose";

const pdfLogSchema = new mongoose.Schema({
  name: { type: String, required: true },
  documentType:{type:String,enum:['offerLetter','joiningLetter','experienceLetter','salarySlip']},
  url:{type:String},
  employeeName:{type:String},
  createdAt: { type: Date, default: Date.now },
});

const PDFLog = mongoose.model("pdfLog", pdfLogSchema);
export default PDFLog;
