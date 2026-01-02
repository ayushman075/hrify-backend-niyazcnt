import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Employee } from "../models/employee.model.js";
import { uploadFileOnCloudinary } from "../utils/cloudinary.js";
import fs from "fs";
import { getCache, setCache, removeCache, removeCachePattern } from "../utils/cache.js";

// Cache Keys Configuration
const CACHE_KEY = {
  PREFIX: "employee_",         // Single items: employee_12345
  LIST_PREFIX: "employee_list_", // Query lists: employee_list_page1_...
  BIRTHDAY_LIST: "employee_birthdays_today" // Special key for birthday list
};

const createEmployee = asyncHandler(async (req, res) => {
    const { 
        employeeId, firstName, middleName, lastName, post, dateOfJoining,gender, dateOfBirth, maritalStatus, 
        contactNo, email, photoUrl, signatureUrl, aadharNo, panNo, esiNo, uanNo, epfNo, 
        presentAddress, permanentAddress, familyDetails, educationDetails, employmentHistory, 
        emergencyContact, bankAccountDetails, nominationDetails, generalInformation, status
    } = req.body;

    // Validation for required fields
    if ( !firstName || !post || !gender || !dateOfBirth || !contactNo ) {
        return res.status(400).json(new ApiResponse(400, {}, 'Some required fields are missing.'));
    }

    // Check if an employee with the same email already exists
    const existingEmployee = await Employee.findOne({ contactNo });
    if (existingEmployee) {
        return res.status(409).json(new ApiResponse(409, {}, 'Employee with this contact number already exists.'));
    }

    // Create the new employee
    const employee = await Employee.create({
        employeeId, firstName, middleName, lastName, post, dateOfJoining,gender, dateOfBirth, maritalStatus, 
        contactNo, email, photo:photoUrl, signature:signatureUrl, aadharNo, panNo, esiNo, uanNo, epfNo, status,
        presentAddress, permanentAddress, familyDetails, educationDetails, employmentHistory, 
        emergencyContact, bankAccountDetails, nominationDetails, generalInformation
    });

    if (!employee) {
        return res.status(500).json(new ApiResponse(500, {}, 'Failed to create employee.'));
    }

    // [CACHE INVALIDATION]
    // 1. Clear general lists
    await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
    // 2. Clear birthday list (in case new employee has birthday today)
    await removeCache(CACHE_KEY.BIRTHDAY_LIST);

    res.status(201).json(new ApiResponse(201, employee, 'Employee created successfully.'));
});

export const uploadEmployeeSignature = asyncHandler(async (req,res)=>{
  const imageLocalPath = req.file?.path;
  let images;
  
 if(imageLocalPath){
  const imgUrl= await uploadFileOnCloudinary(imageLocalPath);
  images=imgUrl;
  fs.unlinkSync(imageLocalPath)
 }
 if(!imageLocalPath){
  return res.status(200).json(
    new ApiResponse(200, { signatureUrl:images }, "Employee Signature not selected!")
  );
 }
 
 return res.status(200).json(
 new ApiResponse(200, { signatureUrl:images }, "Employee Signature uploaded successfully!")
);
})

export const uploadEmployeePhoto = asyncHandler(async (req,res)=>{
  const imageLocalPath = req.file?.path;
  let images;
  
 if(imageLocalPath){
  const imgUrl= await uploadFileOnCloudinary(imageLocalPath);
  images=imgUrl;
  fs.unlinkSync(imageLocalPath)
 }
 if(!imageLocalPath){
  return res.status(200).json(
    new ApiResponse(200, { photoUrl:images }, "Employee Photo not selected!")
  );
 }
 return res.status(200).json(
  new ApiResponse(200, { photoUrl:images }, "Employee Photo uploaded successfully!")
);
})

const getAllEmployees = asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 10,
      sort = "createdAt",
      order = "desc",
      filters = {},
    } = req.query;
  
    // [CACHE READ] Unique key based on query params
    const filterKey = JSON.stringify(filters);
    const cacheKey = `${CACHE_KEY.LIST_PREFIX}p${page}_l${limit}_s${sort}_o${order}_f${filterKey}`;
    
    const cachedData = await getCache(cacheKey);
    if (cachedData) {
        return res.status(200).json(new ApiResponse(200, cachedData, "Employees retrieved from Cache!", true));
    }

    const query = {};
  
    // Apply filters
    if (filters.firstName) {
      query.firstName = { $regex: filters.firstName, $options: "i" };
    }
    if (filters.lastName) {
      query.lastName = { $regex: filters.lastName, $options: "i" };
    }
    if (filters.email) {
      query.email = { $regex: filters.email, $options: "i" };
    }
    if (filters.contactNo) {
      query.contactNo = { $regex: filters.contactNo, $options: "i" };
    }
    if (filters.gender) {
      query.gender = filters.gender;
    }
    if (filters.post) {
      query.post = filters.post; 
    }
    if (filters.status) {
      query.status = filters.status; 
    }
    if (filters.employeeId) {
      query.employeeId = filters.employeeId;
    }
    if (filters.aadharNo) {
      query.aadharNo = filters.aadharNo; 
    }
    if (filters.panNo) {
      query.panNo = filters.panNo;
    }
    if (filters.esiNo) {
      query.esiNo = filters.esiNo; 
    }
    if (filters.uanNo) {
      query.uanNo = filters.uanNo; 
    }
    if (filters.epfNo) {
      query.epfNo = filters.epfNo; 
    }
  
    // Fetch employees
    const employees = await Employee.find(query)
      .populate("post", "title") 
      .sort({ [sort]: order === "desc" ? -1 : 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
  
    const totalEmployees = await Employee.countDocuments(query);
  
    const responsePayload = {
          success: true,
          totalEmployees,
          totalPages: Math.ceil(totalEmployees / limit),
          currentPage: parseInt(page),
          employees,
    };

    // [CACHE WRITE]
    await setCache(cacheKey, responsePayload, 3600);

    return res.status(200).json(
      new ApiResponse(200, responsePayload, "Employees retrieved successfully!", true)
    );
});
  
const getEmployeeById = asyncHandler(async (req, res) => {
    const employeeId = req.params.id;
    if(!employeeId){
        return res.status(409).json(new ApiResponse(409,{},"Employee ID is required."))
    }

    // [CACHE READ]
    const cacheKey = `${CACHE_KEY.PREFIX}${employeeId}`;
    const cachedEmployee = await getCache(cacheKey);
    if (cachedEmployee) {
        return res.status(200).json(new ApiResponse(200, cachedEmployee, 'Employee retrieved from Cache.'));
    }

    const employee = await Employee.findById(employeeId);

    if (!employee) {
        return res.status(404).json(new ApiResponse(404, {}, 'Employee not found.'));
    }

    // [CACHE WRITE]
    await setCache(cacheKey, employee, 3600);

    res.status(200).json(new ApiResponse(200, employee, 'Employee retrieved successfully.'));
});

const updateEmployee = asyncHandler(async (req, res) => {
    const { 
        firstName, middleName, lastName, post,dateOfJoining, gender, dateOfBirth, maritalStatus, 
        contactNo, email, photoUrl, signatureUrl, aadharNo, panNo, esiNo, uanNo, epfNo, status,
        presentAddress, permanentAddress, familyDetails, educationDetails, employmentHistory, 
        emergencyContact, bankAccountDetails, nominationDetails, generalInformation
    } = req.body;

    if (!firstName || !post || !gender || !dateOfBirth || !contactNo) {
        return res.status(400).json(new ApiResponse(400, {}, 'Some required fields are missing.'));
    }

    const existingEmployee = await Employee.findOne({ contactNo, _id: { $ne: req.params.id } });
    if (existingEmployee) {
        return res.status(409).json(new ApiResponse(409, {}, 'Another employee with this contact number already exists.'));
    }

    const updatedEmployee = await Employee.findByIdAndUpdate(
        req.params.id,
        {
            firstName, middleName, lastName, dateOfJoining,post, gender, dateOfBirth, maritalStatus, 
            contactNo, email,  photo:photoUrl, signature:signatureUrl, aadharNo, panNo, esiNo, uanNo, epfNo, status,
            presentAddress, permanentAddress, familyDetails, educationDetails, employmentHistory, 
            emergencyContact, bankAccountDetails, nominationDetails, generalInformation
        },
        { new: true, runValidators: true }
    );

    if (!updatedEmployee) {
        return res.status(404).json(new ApiResponse(404, {}, 'Employee not found.'));
    }

    // [CACHE INVALIDATION]
    // 1. Clear specific employee cache
    await removeCache(`${CACHE_KEY.PREFIX}${req.params.id}`);
    // 2. Clear all list caches
    await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
    // 3. Clear birthday list (dates might have changed)
    await removeCache(CACHE_KEY.BIRTHDAY_LIST);

    res.status(200).json(new ApiResponse(200, updatedEmployee, 'Employee updated successfully.'));
});

const deleteEmployee = asyncHandler(async (req, res) => {
    const employee = await Employee.findByIdAndDelete(req.params.id);

    if (!employee) {
        return res.status(404).json(new ApiResponse(404, {}, 'Employee not found.'));
    }

    // [CACHE INVALIDATION]
    // 1. Clear specific employee cache
    await removeCache(`${CACHE_KEY.PREFIX}${req.params.id}`);
    // 2. Clear all list caches
    await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
    // 3. Clear birthday list
    await removeCache(CACHE_KEY.BIRTHDAY_LIST);

    res.status(200).json(new ApiResponse(200, {}, 'Employee deleted successfully.'));
});

const getEmployeesWithBirthdayToday = asyncHandler(async (req, res) => {
    // [CACHE READ] Check for birthday cache
    const cachedBirthdays = await getCache(CACHE_KEY.BIRTHDAY_LIST);
    if (cachedBirthdays) {
        return res.status(200).json(new ApiResponse(200, cachedBirthdays, "Employees with birthdays today (Cache)!"));
    }

    const today = new Date();
    const todayMonth = today.getMonth() + 1; 
    const todayDay = today.getDate();

    const employees = await Employee.find({
        $expr: {
            $and: [
                { $eq: [{ $month: "$dateOfBirth" }, todayMonth] },
                { $eq: [{ $dayOfMonth: "$dateOfBirth" }, todayDay] }
            ]
        }
    }).populate("post","title");

    // [CACHE WRITE] Save for 12 hours (43200 seconds) so it refreshes next day
    // Note: Invalidated on any CREATE/UPDATE/DELETE action to ensure accuracy
    await setCache(CACHE_KEY.BIRTHDAY_LIST, employees, 43200);

    return res.status(200).json(
        new ApiResponse(200, employees, "Employees with birthdays today retrieved successfully!")
    );
});


export {
    createEmployee,
    getAllEmployees,
    getEmployeeById,
    updateEmployee,
    deleteEmployee,
    getEmployeesWithBirthdayToday
};