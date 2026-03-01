import { asyncHandler } from "../utils/AsyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Employee } from "../models/employee.model.js";
import { Post } from "../models/post.model.js"; // REQUIRED for relationship filtering
import { uploadFileOnCloudinary } from "../utils/cloudinary.js";
import fs from "fs";
import { getCache, setCache, removeCache, removeCachePattern } from "../utils/cache.js";

const CACHE_KEY = {
  PREFIX: "employee_",           
  LIST_PREFIX: "employee_list_", 
  DROPDOWN_PREFIX: "employee_dropdown_", 
  BIRTHDAY_LIST: "employee_birthdays_today" 
};

const createEmployee = asyncHandler(async (req, res) => {
    const { 
        employeeId, firstName, middleName, lastName, post, 
        employmentType, status, dateOfJoining, gender, dateOfBirth, maritalStatus, 
        contactNo, email, photoUrl, signatureUrl, aadharNo, panNo, esiNo, uanNo, epfNo, 
        presentAddress, permanentAddress, familyDetails, educationDetails, employmentHistory, 
        emergencyContact, bankAccountDetails, nominationDetails, generalInformation, site 
    } = req.body;

    if (!firstName || !post || !gender || !dateOfBirth || !contactNo || !employmentType) {
        return res.status(400).json(new ApiResponse(400, {}, 'Some required fields are missing.'));
    }

    const existingEmployee = await Employee.findOne({ contactNo });
    if (existingEmployee) {
        return res.status(409).json(new ApiResponse(409, {}, 'Employee with this contact number already exists.'));
    }

    const employee = await Employee.create({
        employeeId, firstName, middleName, lastName, post, 
        employmentType, status, dateOfJoining, gender, dateOfBirth, maritalStatus, 
        contactNo, email, photo: photoUrl, signature: signatureUrl, aadharNo, panNo, esiNo, uanNo, epfNo,
        presentAddress, permanentAddress, familyDetails, educationDetails, employmentHistory, 
        emergencyContact, bankAccountDetails, nominationDetails, generalInformation, site 
    });

    if (!employee) {
        return res.status(500).json(new ApiResponse(500, {}, 'Failed to create employee.'));
    }

    await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
    await removeCachePattern(`${CACHE_KEY.DROPDOWN_PREFIX}*`);
    await removeCache(CACHE_KEY.BIRTHDAY_LIST);

    res.status(201).json(new ApiResponse(201, employee, 'Employee created successfully.'));
});

const uploadEmployeeSignature = asyncHandler(async (req, res) => {
    const imageLocalPath = req.file?.path;
    let images;
    
    if (imageLocalPath) {
        const imgUrl = await uploadFileOnCloudinary(imageLocalPath);
        images = imgUrl;
        fs.unlinkSync(imageLocalPath);
    }
    
    if (!imageLocalPath) {
        return res.status(200).json(new ApiResponse(200, { signatureUrl: images }, "Employee Signature not selected!"));
    }
    
    return res.status(200).json(new ApiResponse(200, { signatureUrl: images }, "Employee Signature uploaded successfully!"));
});

const uploadEmployeePhoto = asyncHandler(async (req, res) => {
    const imageLocalPath = req.file?.path;
    let images;
    
    if (imageLocalPath) {
        const imgUrl = await uploadFileOnCloudinary(imageLocalPath);
        images = imgUrl;
        fs.unlinkSync(imageLocalPath);
    }
    
    if (!imageLocalPath) {
        return res.status(200).json(new ApiResponse(200, { photoUrl: images }, "Employee Photo not selected!"));
    }
    
    return res.status(200).json(new ApiResponse(200, { photoUrl: images }, "Employee Photo uploaded successfully!"));
});

const getAllEmployees = asyncHandler(async (req, res) => {
    const { page = 1, limit = 10, sort = "createdAt", order = "desc", filters = {} } = req.query;
  
    const filterKey = JSON.stringify(filters);
    const cacheKey = `${CACHE_KEY.LIST_PREFIX}p${page}_l${limit}_s${sort}_o${order}_f${filterKey}`;
    
    const cachedData = await getCache(cacheKey);
    if (cachedData) {
        return res.status(200).json(new ApiResponse(200, cachedData, "Employees retrieved from Cache!", true));
    }

    const query = {};
  
    if (filters.firstName) query.firstName = { $regex: filters.firstName, $options: "i" };
    if (filters.lastName) query.lastName = { $regex: filters.lastName, $options: "i" };
    if (filters.email) query.email = { $regex: filters.email, $options: "i" };
    if (filters.contactNo) query.contactNo = { $regex: filters.contactNo, $options: "i" };
    if (filters.gender) query.gender = filters.gender;
    if (filters.status) query.status = filters.status; 
    if (filters.employmentType) query.employmentType = filters.employmentType; 
    if (filters.site) query.site = filters.site;
    if (filters.employeeId) query.employeeId = filters.employeeId;
    if (filters.aadharNo) query.aadharNo = filters.aadharNo; 
    if (filters.panNo) query.panNo = filters.panNo;
    if (filters.esiNo) query.esiNo = filters.esiNo; 
    if (filters.uanNo) query.uanNo = filters.uanNo; 
    if (filters.epfNo) query.epfNo = filters.epfNo; 

    // --- Complex Relational Filtering for Department and Division via Post ---
    if (filters.department || filters.division || filters.post) {
        const postFilter = {};
        if (filters.department) postFilter.department = filters.department;
        if (filters.division) postFilter.division = filters.division;
        if (filters.post) postFilter._id = filters.post; // Intersect if specific post also provided

        const matchingPosts = await Post.find(postFilter).select('_id');
        const postIds = matchingPosts.map(p => p._id);

        if (postIds.length === 0) {
            // If no posts match the department/division, force query to return empty
            query.post = null; 
        } else {
            query.post = { $in: postIds };
        }
    }
  
    const employees = await Employee.find(query)
      .populate({
        path: 'post',
        populate: [
          { path: 'department', select: 'name' },
          { path: 'division', select: 'name' }
        ]
      })
      .populate("site", "siteName") 
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

    await setCache(cacheKey, responsePayload, 3600);

    return res.status(200).json(new ApiResponse(200, responsePayload, "Employees retrieved successfully!", true));
});

const getEmployeeDropdown = asyncHandler(async (req, res) => {
    const { status, departmentId, divisionId, postId } = req.query;

    const cacheKey = `${CACHE_KEY.DROPDOWN_PREFIX}s${status}_d${departmentId}_div${divisionId}_p${postId}`;
    const cachedData = await getCache(cacheKey);
    
    if (cachedData) {
        return res.status(200).json(new ApiResponse(200, cachedData, "Employee dropdown fetched from cache", true));
    }

    const query = {};
    if (status) query.status = status;

    // Relational Filtering
    if (departmentId || divisionId || postId) {
        const postFilter = {};
        if (departmentId) postFilter.department = departmentId;
        if (divisionId) postFilter.division = divisionId;
        if (postId) postFilter._id = postId;

        const matchingPosts = await Post.find(postFilter).select('_id');
        const postIds = matchingPosts.map(p => p._id);

        if (postIds.length === 0) {
            query.post = null; 
        } else {
            query.post = { $in: postIds };
        }
    }

    const employees = await Employee.find(query)
        .select("firstName lastName employeeId photo status employmentType post")
        .populate({
          path: 'post',
          populate: [
            { path: 'department', select: 'name' },
            { path: 'division', select: 'name' }
          ]
        })
        .limit(500)
        .sort({ firstName: 1, lastName: 1 });

    const responsePayload = {
        success: true,
        totalCount: employees.length,
        employees,
    };

    await setCache(cacheKey, responsePayload, 3600);

    return res.status(200).json(new ApiResponse(200, responsePayload, "Employee dropdown fetched successfully", true));
});

const getEmployeeById = asyncHandler(async (req, res) => {
    const employeeId = req.params.id;
    if (!employeeId) {
        return res.status(409).json(new ApiResponse(409, {}, "Employee ID is required."));
    }

    const cacheKey = `${CACHE_KEY.PREFIX}${employeeId}`;
    const cachedEmployee = await getCache(cacheKey);
    if (cachedEmployee) {
        return res.status(200).json(new ApiResponse(200, cachedEmployee, 'Employee retrieved from Cache.'));
    }

    const employee = await Employee.findById(employeeId)
        .populate({
            path: 'post',
            populate: [
              { path: 'department', select: 'name' },
              { path: 'division', select: 'name' }
            ]
        })
        .populate("site", "name");

    if (!employee) {
        return res.status(404).json(new ApiResponse(404, {}, 'Employee not found.'));
    }

    await setCache(cacheKey, employee, 3600);

    res.status(200).json(new ApiResponse(200, employee, 'Employee retrieved successfully.'));
});

const updateEmployee = asyncHandler(async (req, res) => {
    const { 
        firstName, middleName, lastName, post, 
        employmentType, status, dateOfJoining, gender, dateOfBirth, maritalStatus, 
        contactNo, email, photoUrl, signatureUrl, aadharNo, panNo, esiNo, uanNo, epfNo, 
        presentAddress, permanentAddress, familyDetails, educationDetails, employmentHistory, 
        emergencyContact, bankAccountDetails, nominationDetails, generalInformation, site
    } = req.body;

    const existingEmployee = await Employee.findOne({ contactNo, _id: { $ne: req.params.id } });
    if (existingEmployee) {
        return res.status(409).json(new ApiResponse(409, {}, 'Another employee with this contact number already exists.'));
    }

    const updatedEmployee = await Employee.findByIdAndUpdate(
        req.params.id,
        {
            firstName, middleName, lastName, post, 
            employmentType, status, dateOfJoining, gender, dateOfBirth, maritalStatus, 
            contactNo, email, photo: photoUrl, signature: signatureUrl, aadharNo, panNo, esiNo, uanNo, epfNo, 
            presentAddress, permanentAddress, familyDetails, educationDetails, employmentHistory, 
            emergencyContact, bankAccountDetails, nominationDetails, generalInformation, site
        },
        { new: true, runValidators: true }
    );

    if (!updatedEmployee) {
        return res.status(404).json(new ApiResponse(404, {}, 'Employee not found.'));
    }

    await removeCache(`${CACHE_KEY.PREFIX}${req.params.id}`);
    await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
    await removeCachePattern(`${CACHE_KEY.DROPDOWN_PREFIX}*`);
    await removeCache(CACHE_KEY.BIRTHDAY_LIST);

    res.status(200).json(new ApiResponse(200, updatedEmployee, 'Employee updated successfully.'));
});

const deleteEmployee = asyncHandler(async (req, res) => {
    const employee = await Employee.findByIdAndDelete(req.params.id);

    if (!employee) {
        return res.status(404).json(new ApiResponse(404, {}, 'Employee not found.'));
    }

    await removeCache(`${CACHE_KEY.PREFIX}${req.params.id}`);
    await removeCachePattern(`${CACHE_KEY.LIST_PREFIX}*`);
    await removeCachePattern(`${CACHE_KEY.DROPDOWN_PREFIX}*`);
    await removeCache(CACHE_KEY.BIRTHDAY_LIST);

    res.status(200).json(new ApiResponse(200, {}, 'Employee deleted successfully.'));
});

const getEmployeesWithBirthdayToday = asyncHandler(async (req, res) => {
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
    })
    .populate({
        path: 'post',
        populate: [
          { path: 'department', select: 'name' },
          { path: 'division', select: 'name' }
        ]
    })
    .populate("site", "name");

    await setCache(CACHE_KEY.BIRTHDAY_LIST, employees, 43200);

    return res.status(200).json(new ApiResponse(200, employees, "Employees with birthdays today retrieved successfully!"));
});

export {
    createEmployee,
    uploadEmployeeSignature,
    uploadEmployeePhoto,
    getAllEmployees,
    getEmployeeDropdown, 
    getEmployeeById,
    updateEmployee,
    deleteEmployee,
    getEmployeesWithBirthdayToday
};