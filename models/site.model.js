import mongoose, {Schema} from "mongoose";

const siteSchema = new Schema(
    {
        siteName: {
          type: String,
          required: true,
          trim: true,
        },
        location: {
          type: String,   
      },
      alisas: {
        type: String,   
      }
    },
      {
        timestamps: true,
      }
)

export const Site = mongoose.model("Site",siteSchema)