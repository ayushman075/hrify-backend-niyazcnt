import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Candidate } from "../models/candidate.model.js";
import { uploadFileOnCloudinary } from "../utils/cloudinary.js";
import fs from 'fs';

const createCandidate = asyncHandler(async (req, res) => {
    const {
      name,
      email,
      contactNo,
      post,
      applicationStatus,
      applicationDate,
      interviewDate,
      appointmentDate,
      resumeUrl,
    } = req.body;

  
    if (!name || !email || !contactNo || !post) {
      return res
        .status(400)
        .json(new ApiResponse(400, {}, "Some required fields are empty!"));
    }


  
    const candidate = await Candidate.create({
      name,
      email,
      contactNo,
      post,
      applicationDate,
      applicationStatus,
      interviewDate,
      appointmentDate,
      resumeUrl
    });
  
    return res
      .status(201)
      .json(new ApiResponse(201, candidate, "Candidate created successfully!"));
  });
  

const getAllCandidates = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    sort = "createdAt",
    order = "desc",
    filters = {},
  } = req.query;

  const query = {};

  // Apply filters
  if (filters.name) {
    query.name = { $regex: filters.name, $options: "i" };
  }
  if (filters.email) {
    query.email = { $regex: filters.email, $options: "i" };
  }
  if (filters.contact) {
    query.contact = { $regex: filters.contact, $options: "i" };
  }
  if (filters.applicationStatus) {
    query.applicationStatus = filters.applicationStatus;
  }
  if (filters.post) {
    query.post = filters.post; // Assuming `post` is an ObjectId, no regex needed
  }

  // Fetch candidates
  const candidates = await Candidate.find(query)
    .populate("post", "title")
    .sort({ [sort]: order === "desc" ? -1 : 1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  const totalCandidates = await Candidate.countDocuments(query);

  return res.status(200).json(new ApiResponse(200, {
    success: true,
    totalCandidates,
    totalPages: Math.ceil(totalCandidates / limit),
    currentPage: page,
    candidates,
  }, "Candidates retrieved successfully!",true));
});

const getCandidate = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id)
  .populate("post", "title");


  if (!candidate) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Candidate not found!"));
  }

  return res
    .status(200)
    .json(new ApiResponse(200, candidate, "Candidate retrieved successfully!"));
});

const getLatestCandidateId = asyncHandler(async (req, res) => {
    const latestCandidate = await Candidate.findOne().sort({ candidateId: -1 });
  
    const latestId = latestCandidate ? latestCandidate.candidateId : null;
  
    return res.status(200).json(
      new ApiResponse(200, { candidateId: latestId }, "Latest Candidate ID retrieved successfully!")
    );
  });

  const uploadResume = asyncHandler(async (req,res)=>{
    const imageLocalPath = req.file?.path;
 
     
    let images;
    
   if(imageLocalPath){
    const imgUrl= await uploadFileOnCloudinary(imageLocalPath);
    images=imgUrl;
    fs.unlinkSync(imageLocalPath)
   }
   if(!imageLocalPath){
    return res.status(200).json(
      new ApiResponse(200, { resumeUrl:images }, "Resume not selected!")
    );
    
   }

   return res.status(200).json(
    new ApiResponse(200, { resumeUrl:images }, "Resume uploaded successfully!")
  );
  })

const updateCandidate = asyncHandler(async (req, res) => {
  const {
    name,
    email,
    contactNo,
    appliedPost,
    applicationStatus,
    applicationDate,
    interviewDate,
    appointmentDate,
    resumeUrl,
  } = req.body;
console.log(resumeUrl)
  const candidate = await Candidate.findById(req.params.id);

  if (!candidate) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Candidate not found!"));
  }

  candidate.name = name || candidate.name;
  candidate.email = email || candidate.email;
  candidate.contactNo = contactNo || candidate.contactNo;
  candidate.appliedPost = appliedPost || candidate.appliedPost;
  candidate.applicationStatus = applicationStatus || candidate.applicationStatus;
  candidate.applicationDate = applicationDate || candidate.applicationDate;
  candidate.interviewDate = interviewDate || candidate.interviewDate;
  candidate.appointmentDate = appointmentDate || candidate.appointmentDate;
  candidate.resumeUrl = resumeUrl || candidate.resumeUrl;

  await candidate.save();

  return res
    .status(200)
    .json(new ApiResponse(200, candidate, "Candidate updated successfully!"));
});

const deleteCandidate = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findByIdAndDelete(req.params.id);

  if (!candidate) {
    return res
      .status(404)
      .json(new ApiResponse(404, {}, "Candidate not found!"));
  }


  return res
    .status(200)
    .json(new ApiResponse(200, {}, "Candidate deleted successfully!"));
});

export {
  createCandidate,
  getAllCandidates,
  getCandidate,
  getLatestCandidateId,
  updateCandidate,
  deleteCandidate,
  uploadResume
};
