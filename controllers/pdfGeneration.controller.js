import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { Candidate } from '../models/candidate.model.js';
import { Employee } from '../models/employee.model.js';
import { pdfGenerationQueue } from '../db/redis.config.js';
import PDFLog from '../models/pdfGeneration.model.js';
import { Payroll } from '../models/payroll.model.js';
import { asyncHandler } from '../utils/AsyncHandler.js';
import { getCache, setCache } from "../utils/cache.js";

// Cache Keys Configuration
const CACHE_KEY = {
  PREFIX: "pdf_log_",           // Single ID: pdf_log_12345
  LIST_PREFIX: "pdf_log_list_"  // Query lists
};

const generateOfferLetter = asyncHandler(async (req, res) => {
  const { candidateId } = req.params;
  const { joiningDate, salaryDetails, workLocation, acceptanceDeadline, department } = req.body;
  
  if (!candidateId) {
    return res.status(400).json(
        new ApiResponse(400, {}, "Candidate ID is required", false)
        )
  }
  
  const candidate = await Candidate.findById(candidateId).populate("post");
  
  if (!candidate) {
    return res.status(404).json(
    new ApiResponse(404, {}, "Candidate not found", false)
    )
  }
  
  // Prepare data for PDF generation
  const candidateData = {
    candidateId: candidate._id,
    candidateName: candidate.name,
    jobTitle: candidate.post.title,
    companyName: process.env.COMPANY_NAME || "YourCompany",
    joiningDate: joiningDate || candidate.joiningDate,
    salaryDetails: salaryDetails || candidate.offeredSalary,
    workLocation: workLocation || candidate.workLocation,
    acceptanceDeadline: acceptanceDeadline || candidate.acceptanceDeadline,
    department: department || candidate.department,
    hrName: candidate?.hrAssigned?.name || process.env.HR_NAME || "HR Manager",
    generationDate: new Date().toLocaleDateString()
  };
  
  // Add to queue for processing
  await pdfGenerationQueue.add('pdfGenerationQueue', {type:"offerLetter", requestBody:candidateData}, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    }
  });
  
  return res.status(200).json(
    new ApiResponse(200, { queued: true, candidateId }, "Offer letter generation queued successfully")
  );
});


const generateJoiningLetter = asyncHandler(async (req, res) => {
  const { employeeId } = req.params;
  const { joiningDate, workLocation, designation, department } = req.body;
  
  if (!employeeId) {
    return res.status(400).json(
        new ApiResponse(400, {}, "Employee ID is required", false)
        )
  }
  
  // Fetch employee details from database
  const employee = await Employee.findById(employeeId).populate("post");
  
  if (!employee) {
    return res.status(404).json(
        new ApiResponse(404, {}, "Employee not found", false)
        )
  }
  
  // Prepare data for PDF generation
  const employeeData = {
    employeeId: employee._id,
    employeeName: employee.firstName+" "+employee.middleName+" "+employee.lastName,
    companyName: process.env.COMPANY_NAME || "YourCompany",
    joiningDate: joiningDate || employee.joiningDate,
    workLocation: workLocation || employee.workLocation,
    
    designation: designation || employee.post.title,
    department: department || employee?.post?.department?.name,
    salaryDetails: employee.post.salary.total,
    generationDate: new Date().toLocaleDateString()
  };
  
  await pdfGenerationQueue.add('pdfGenerationQueue', {type:"joiningLetter", requestBody:employeeData}, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    }
  });
  
  return res.status(200).json(
    new ApiResponse(200, { queued: true, employeeId }, "Joining letter generation queued successfully")
  );
});

// Controller for generating experience letter
const generateExperienceLetter = asyncHandler(async (req, res) => {
  const { employeeId } = req.params;
  const { 
    startDate, 
    endDate, 
    department, 
    responsibility1, 
    responsibility2, 
    responsibility3 
  } = req.body;
  
  if (!employeeId) {
    throw new ApiError(400, "Employee ID is required");
  }
  
  // Fetch employee details from database
  const employee = await Employee.findById(employeeId).populate("post");
  
  if (!employee) {
    throw new ApiError(404, "Employee not found");
  }
  
  // Prepare data for PDF generation
  const employeeData = {
    employeeId: employee._id,
    employeeName: employee.firstName+" "+employee.middleName+" "+employee.lastName,
    jobTitle: employee.post.title,
    companyName: process.env.COMPANY_NAME || "YourCompany",
    employmentType: employee.status || "Full-time",
    gender: employee.gender || "male",
    startDate: startDate || employee.joiningDate,
    endDate: endDate || employee.exitDate || new Date().toISOString().split('T')[0],
    department: department || employee.department,
    responsibility1: responsibility1 || employee.responsibilities?.[0] || "Key responsibility 1",
    responsibility2: responsibility2 || employee.responsibilities?.[1] || "Key responsibility 2",
    responsibility3: responsibility3 || employee.responsibilities?.[2] || "Key responsibility 3",
    signatoryName: process.env.SIGNATORY_NAME || "HR Manager",
    signatoryTitle: process.env.SIGNATORY_TITLE || "HR Manager",
    generationDate: new Date().toLocaleDateString()
  };
  
  await pdfGenerationQueue.add('pdfGenerationQueue', {type:"experienceLetter", requestBody:employeeData}, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    }
  });
  
  return res.status(200).json(
    new ApiResponse(200, { queued: true, employeeId }, "Experience letter generation queued successfully")
  );
});



const generatePayrollSlip = asyncHandler(async (req, res) => {
    const { employeeId } = req.params;
    const { month } = req.body;
    
    if (!employeeId) {
      return res.status(400).json(
        new ApiResponse(400, {}, "Employee ID is required", false)
      );
    }
    
    if (!month) {
      return res.status(400).json(
        new ApiResponse(400, {}, "Month is required", false)
      );
    }
    
    // Fetch employee details from database
    const employee = await Employee.findById(employeeId).populate("post");
    
    if (!employee) {
      return res.status(404).json(
        new ApiResponse(404, {}, "Employee not found", false)
      );
    }
    
    // Find payroll data for the specified month
    const payroll = await Payroll.findOne({ 
      employee: employeeId,
      month: month
    });
    
    if (!payroll) {
      return res.status(404).json(
        new ApiResponse(404, {}, "Payroll data not found for the specified month", false)
      );
    }
    
    const netSalaryInWords = convertNumberToWords(payroll.netSalary);
    
    const payrollData = {
      employeeId: employee.employeeId,
      employeeName: employee.firstName + " " + employee.middleName + " " + employee.lastName,
      designation: employee.post.title,
      department: employee.department,
      companyName: process.env.COMPANY_NAME || "YourCompany",
      month: payroll.month,
      payPeriod: `1st ${payroll.month} - Last day of ${payroll.month}`,
      bankAccount: employee.bankAccountNumber || "XXXXXXXXXXXX",
      panNumber: employee.panNumber || "XXXXXXXXXX",
      attendance: payroll.attendance,
      earnings: payroll.earnings,
      deductions: payroll.deductions,
      netSalary: payroll.netSalary,
      netSalaryInWords: netSalaryInWords,
      status: payroll.status,
      generationDate: new Date().toLocaleDateString()
    };
    
    // Add the job to the queue
    await pdfGenerationQueue.add('pdfGenerationQueue', {type: "payrollSlip", requestBody: payrollData}, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000
      }
    });
    
    return res.status(200).json(
      new ApiResponse(200, { queued: true, employeeId, month }, "Payroll slip generation queued successfully")
    );
  });
  
  function convertNumberToWords(amount) {
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    
    const convertNumber = (num) => {
      if (num < 10) return ones[num];
      if (num < 20) return teens[num - 10];
      if (num < 100) return tens[Math.floor(num / 10)] + (num % 10 !== 0 ? ' ' + ones[num % 10] : '');
      if (num < 1000) return ones[Math.floor(num / 100)] + ' Hundred' + (num % 100 !== 0 ? ' ' + convertNumber(num % 100) : '');
      if (num < 100000) return convertNumber(Math.floor(num / 1000)) + ' Thousand' + (num % 1000 !== 0 ? ' ' + convertNumber(num % 1000) : '');
      if (num < 10000000) return convertNumber(Math.floor(num / 100000)) + ' Lakh' + (num % 100000 !== 0 ? ' ' + convertNumber(num % 100000) : '');
      return convertNumber(Math.floor(num / 10000000)) + ' Crore' + (num % 10000000 !== 0 ? ' ' + convertNumber(num % 10000000) : '');
    };
    
    const rupees = Math.floor(amount);
    const paise = Math.round((amount - rupees) * 100);
    
    let result = convertNumber(rupees) + ' Rupees';
    if (paise > 0) {
      result += ' and ' + convertNumber(paise) + ' Paise';
    }
    
    return result + ' Only';
  }



const getAllPDFLogs = asyncHandler(async (req, res) => {
    const { 
      page = 1, 
      limit = 10, 
      documentType, 
      startDate, 
      endDate, 
      employeeName 
    } = req.query;
    
    // [CACHE READ] Unique key based on all filters
    const filterKey = JSON.stringify(req.query);
    const cacheKey = `${CACHE_KEY.LIST_PREFIX}${filterKey}`;
    const cachedData = await getCache(cacheKey);
    if (cachedData) {
        return res.status(200).json(new ApiResponse(200, cachedData, "PDF logs fetched from Cache"));
    }

    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { createdAt: -1 }
    };
    
    const filter = {};
    
    if (documentType) {
      filter.documentType = documentType;
    }
    
    if (employeeName) {
      filter.employeeName = { $regex: employeeName, $options: 'i' };
    }
    
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        filter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        const endDateTime = new Date(endDate);
        endDateTime.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = endDateTime;
      }
    }
    
    const pdfLogs = await PDFLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit));
    
    const totalDocs = await PDFLog.countDocuments(filter);
    const totalPages = Math.ceil(totalDocs / parseInt(limit));
    
    const responsePayload = {
        logs: pdfLogs,
        totalDocs,
        page: parseInt(page),
        totalPages,
        hasNextPage: parseInt(page) < totalPages,
        hasPrevPage: parseInt(page) > 1
    };

    // [CACHE WRITE] Save for 5 minutes (Short TTL due to async nature)
    await setCache(cacheKey, responsePayload, 300);

    return res.status(200).json(
      new ApiResponse(200, responsePayload, "PDF logs fetched successfully")
    );
  });

  
  
// Get a single PDF by ID
const getPDFById = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const cacheKey = `${CACHE_KEY.PREFIX}${id}`;
    
    // [CACHE READ]
    const cachedLog = await getCache(cacheKey);
    if (cachedLog) {
        return res.status(200).json(new ApiResponse(200, cachedLog, "PDF fetched from Cache"));
    }

    const pdfLog = await PDFLog.findById(id);
    
    if (!pdfLog) {
      return res.status(404).json(
        new ApiResponse(404, {}, "PDF not found", false)
      );
    }
    
    // [CACHE WRITE] Save for 1 hour (PDF logs are usually immutable)
    await setCache(cacheKey, pdfLog, 3600);

    return res.status(200).json(
      new ApiResponse(200, pdfLog, "PDF fetched successfully")
    );
  });
  


export { 
  generateOfferLetter, 
  generateJoiningLetter, 
  generateExperienceLetter,
  generatePayrollSlip,
  getAllPDFLogs,
  getPDFById 
};