import mongoose from 'mongoose'
const { Schema } = mongoose;


const EmployeeSchema = new Schema({
  employeeId: {
    type: Number,
    unique: true,
  },
  firstName: { type: String, required: true },
  middleName: { type: String },
  lastName: { type: String},
  status: {type:String, enums:['Active','Terminated','PartTime','Contractual','Suspended','Probation','Resigned','Promoted','Inactive'],default:'Active',required:true},
  post:{
    type:mongoose.Schema.Types.ObjectId,
    ref:"Post",
    required:true
  },
  dateOfJoining:{
    type:Date,
    default:Date.now
  },
  lastWorkingDate:{
    type:Date,
  },
  gender: { type: String, enum: ["Male", "Female", "Others"], required: true },
  dateOfBirth: { type: Date, required: true },
  maritalStatus: { type: String, enum: ["Married", "Unmarried", "Divorced" ,"Others"] },
  contactNo: { type: String, required: true },
  email: { type: String },
  photo:{type:String},
  signature:{type:String},
  aadharNo: { type: String },
  panNo: { type: String },
  esiNo: { type: String },
  uanNo: { type: String },
  epfNo: { type: String },
  presentAddress: {
    city: { type: String },
    block: { type: String },
    district: { type: String },
    state: { type: String },
    pin: { type: String },
  },
  permanentAddress: {
    city: { type: String },
    block: { type: String },
    district: { type: String },
    state: { type: String },
    pin: { type: String },
    },
  familyDetails: [
    {
      name: { type: String },
      relationship: { type: String,enum:['Father','Mother','Spouse','Child'] },
      gender: { type: String },
      age: { type: Number },
      occupation: { type: String },
      contactNo: { type: String },
    },
  ],
  educationDetails: [
    {
      examination: { type: String },
      streamBranch: { type: String },
      schoolCollege: { type: String },
      boardUniversity: { type: String },
      marksObtained: { type: String },
      yearOfPassing: { type: Number },
    },
  ],
  employmentHistory: [
    {
      employerName: { type: String },
      address: { type: String },
      fromDate: { type: Date },
      toDate: { type: Date },
      lastPosition: { type: String },
      lastDrawnSalary: { type: Number },
      reasonForLeaving: { type: String },
    },
  ],
  emergencyContact: {
    name: { type: String },
    relationship: { type: String },
    contactNo: { type: String },
  },
  bankAccountDetails: {
    accountHolderName: { type: String },
    accountNumber: { type: String },
    ifscCode: { type: String },
    bankName: { type: String },
    branchName: { type: String },
  },
  nominationDetails: {
    name: { type: String },
    relationship: { type: String },
  },
  generalInformation: {
    convicted: { type: Boolean, default: false },
    terminationHistory: { type: Boolean, default: false },
    healthIssues: { type: Boolean, default: false },
  },
});

EmployeeSchema.pre('validate', async function(next) {
  if (!this.employeeId) {
    const lastEmployee = await this.constructor.findOne().sort({ employeeId: -1 });
    this.employeeId = lastEmployee ? lastEmployee.employeeId + 1 : 100001;
  }
  next();
});

export const Employee = mongoose.model("Employee", EmployeeSchema);
