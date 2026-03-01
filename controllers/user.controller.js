import { clerkClient } from "@clerk/clerk-sdk-node";
import {User} from "../models/user.model.js"
import {ApiResponse} from "../utils/ApiResponse.js";
import {asyncHandler} from "../utils/AsyncHandler.js";
import { Webhook } from "svix";


const clerkWebhookListener = asyncHandler(async (req,res)=>{
    const SIGNING_SECRET =  process.env.CLERK_WEBHOOK_SECRET_KEY;
    if (!SIGNING_SECRET) {
      console.error("Error: SIGNING_SECRET is missing in environment variables.");
      return res.status(500).json(new ApiResponse(500,{},"Internal server error",false));
    }

    const webhook = new Webhook(SIGNING_SECRET);

    const headers = req.headers;
    const payload = JSON.stringify(req.body);
    
    

    
    const svix_id = headers["svix-id"];
    const svix_timestamp = headers["svix-timestamp"];
    const svix_signature = headers["svix-signature"];

    
    if (!svix_id || !svix_timestamp || !svix_signature) {
      return res.status(400).json(
        new ApiResponse(400,{},"Missing Svix headers for webhook verification",false)
       );
    }

    let evt;
    try {
      evt = webhook.verify(payload, {
        "svix-id": svix_id,
        "svix-timestamp": svix_timestamp,
        "svix-signature": svix_signature,
      });
    } catch (err) {
      console.error("Webhook verification failed:", err.message);
      return res.status(400).json(
        new ApiResponse(400,{},"Webhook verification failed",false));
    }

    const userData = evt.data;
    const eventType = evt.type;

    if (eventType === "user.created" || eventType === "user.updated") {
        const user = {
          userId: userData.id,
          email: userData.email_addresses?.[0]?.email_address,
          fullName: userData.first_name+" "+userData.last_name,
        };
        await User.findOneAndUpdate(
            { userId: userData.id },
            user,
            { upsert: true, new: true }
          );
      }

    return res.status(200).json(
        new ApiResponse(200,{},"Webhook processed successfully",true)
       );
    
})


const updateUserProfile = asyncHandler(async (req,res)=>{
  const {userId,fullName,contactNumber,role,employeeId} = req.body;

  if(!userId){
    return res.status(401).json(new ApiResponse(401,{},"Unautorized Request",false))
  }
  if(!contactNumber || !role || !employeeId || !fullName){
    return res.status(409).json(new ApiResponse(409,{},"Some fields are empty",false))
  }


  const user = await User.findOne({userId:userId});
  if(!user){
    return res.status(404).json(new ApiResponse(404,{},"User not found",false))
  }

  const updatedUser = await User.findOneAndUpdate(
    {userId:userId},
    {
      fullName,
      contactNumber,
      role,
      employeeId
    },
    {
      new:true
    }
  )
  return res.status(200).json(new ApiResponse(200,updatedUser,"User updated successfully",true))
})
  

const getUserProfile = asyncHandler(async (req,res)=>{
  const userId = req.auth.userId;
  if(!userId){
    return res.status(401).json(new ApiResponse(401,{},"Unautorized Request",false))
  }

  const user = await User.findOne({userId:userId});
  if(!user){
    return res.status(404).json(new ApiResponse(404,{},"User not found",false))
  }

  return res.status(200).json(new ApiResponse(200,user,"User retrieved successfully",true))
})


const getAllUsers = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    sort = "createdAt",
    order = "desc",
    filters = {},
  } = req.query;

  const query = {};

  // Apply filters based on User schema
  if (filters.fullName) {
    query.fullName = { $regex: filters.fullName, $options: "i" };
  }

  if (filters.role) {
    query.role = filters.role; // Assuming role is an exact match
  }


  // Fetch users with pagination and sorting
  const users = await User.find(query)
    .sort({ [sort]: order === "desc" ? -1 : 1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit))
    .populate("employeeId","employeeId firstName lastName")

  // Get total count for pagination
  const totalUsers = await User.countDocuments(query);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        success: true,
        totalUsers,
        totalPages: Math.ceil(totalUsers / limit),
        currentPage: parseInt(page),
        users:users,
      },
      "Users retrieved successfully",
      true
    )
  );
});




const createUser = asyncHandler(async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required." });
    }


    const user = await clerkClient.users.createUser({
      emailAddress: [email], // Ensure it's an array
      password: password
    });

    if (!user) {
      return res.status(500).json({ success: false, message: "Error creating user." });
    }

    return res.status(201).json({ success: true, user, message: "User created successfully." });

  } catch (error) {
    
    if (error.errors) {
      return res.status(422).json({ success: false, message: error.errors });
    }

    return res.status(500).json({ success: false, message: "Internal Server Error." });
  }
});



const deleteUser = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const user = await User.findById(id);
  if (!user) {
    return res.status(404).json(new ApiResponse(404, {}, "User not found", false));
  }

  try {
    // Delete user from Clerk
    await clerkClient.users.deleteUser(user.userId);

    // Delete user from MongoDB
    await User.findByIdAndDelete(id);

    return res.status(200).json(new ApiResponse(200, {}, "User deleted successfully", true));
  } catch (error) {
    return res.status(500).json(new ApiResponse(500, {}, "Error deleting user", false));
  }
});

export {clerkWebhookListener,updateUserProfile,getUserProfile,getAllUsers,createUser,deleteUser}