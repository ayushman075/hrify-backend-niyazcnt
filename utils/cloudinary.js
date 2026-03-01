import {v2 as cloudinary} from 'cloudinary';
import fs from "fs";


    const uploadFileOnCloudinary=async(localFilePath)=>{
        cloudinary.config({ 
            cloud_name: `${process.env.CLOUDINARY_CLOUD_NAME}`, 
            api_key: `${process.env.CLOUDINARY_API_KEY}`, 
            api_secret: `${process.env.CLOULINARY_SECRET_KEY}`
        })
try {
    if(!localFilePath) return null;
    //upload on cloudinary
    const response = await cloudinary.uploader.upload(localFilePath,{
        resource_type:'auto',
    })
    //dev temp start
console.log("File uploaded on cloudinary ",response.url)
      //dev temp end
     
      return response.url;
} catch (error) {
     //dev temp start
     console.log(error)
      //dev temp end
   
    return "";
}
    }


    const deleteFileFromCloudinary = async (publicId) => {
    try {
        if (!publicId) return null;
        // The resource_type 'image' is the default and works for PDFs in Cloudinary as well
        const response = await cloudinary.uploader.destroy(publicId);
        return response;
    } catch (error) {
        console.error("Cloudinary deletion failed", error);
        return null;
    }
};

export const uploadFileOnCloudinaryNew = async (localFilePath) => {
      cloudinary.config({ 
            cloud_name: `${process.env.CLOUDINARY_CLOUD_NAME}`, 
            api_key: `${process.env.CLOUDINARY_API_KEY}`, 
            api_secret: `${process.env.CLOULINARY_SECRET_KEY}`
        })
    try {
        if (!localFilePath) return null;
        // Upload the file to cloudinary
        const response = await cloudinary.uploader.upload(localFilePath, {
            resource_type: "auto", // Automatically detects PDF vs Image
            
        });
        
        // Return BOTH url and public_id
        return {
            url: response.secure_url,
            publicId: response.public_id,
            format: response.format
        };
    } catch (error) {
        return null;
    } finally {
        // Always remove the locally saved temporary file
        if (fs.existsSync(localFilePath)) {
            fs.unlinkSync(localFilePath);
        }
    }
};


    export {uploadFileOnCloudinary, deleteFileFromCloudinary}