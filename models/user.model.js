import mongoose, {Schema} from "mongoose";

const userSchema=new Schema(
    {
      userId:{
        type:String,
        required:true
      },
        fullName: {
          type: String,
          trim: true,
        },
        email: {
          type: String,
          required: true,
          trim: true,
          unique: true,
          lowercase: true,
          index: true,
        },
        contactNumber:{
          type:Number
        },
        role: {
          type: String,
          default:'Employee',
          enum: ["Admin", "HR Manager", "HR Assistant","Head of Department","Employee"],
        },
        employeeId: {
          type: mongoose.Types.ObjectId,
          ref:'Employee'
        }
      },
      {
        timestamps: true,
      }
)

export const User = mongoose.model("User",userSchema)