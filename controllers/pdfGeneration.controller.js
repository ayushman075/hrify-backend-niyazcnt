import fs from 'fs';
import path from 'path';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { Candidate } from '../models/candidate.model.js';
import { Employee } from '../models/employee.model.js';
import { Payroll } from '../models/payroll.model.js';
import { asyncHandler } from '../utils/AsyncHandler.js';

// Helper: Convert Image to Base64
const getBase64Logo = () => {
    try {
        // Adjust path to where your logo is stored on the server
        const logoPath = path.resolve('assets', 'bimsLogo.png'); 
        if (fs.existsSync(logoPath)) {
            const bitmap = fs.readFileSync(logoPath);
            return Buffer.from(bitmap).toString('base64');
        }
        return '';
    } catch (error) {
        console.error("Error reading logo:", error);
        return '';
    }
};

// Helper: Number to Words
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

// 1. Offer Letter Data
const getOfferLetterData = asyncHandler(async (req, res) => {
    const { candidateId } = req.params;
    const { joiningDate, salaryDetails, workLocation, acceptanceDeadline, department } = req.body;

    const candidate = await Candidate.findById(candidateId).populate("post");
    if (!candidate) throw new ApiError(404, "Candidate not found");

    const data = {
        candidateName: candidate.name,
        jobTitle: candidate.post?.title || "N/A",
        department: department || candidate.department,
        companyName: process.env.COMPANY_NAME || "BIMS Hospital",
        companyAddress: process.env.COMPANY_ADDRESS || "Gandhinagar Pada, Jail Road, Balangir, Odisha, 767001",
        companyWebsite: process.env.COMPANY_WEBSITE || "www.bimshospitals.com",
        companyContact: process.env.COMPANY_PHONE || "8455005505",
        companyEmail: process.env.COMPANY_EMAIL || "hr@bimshospitals.com",
        companyID: process.env.COMPANY_ID || "123456789",
        joiningDate: joiningDate || candidate.joiningDate,
        salaryDetails: salaryDetails || candidate.offeredSalary,
        workLocation: workLocation || candidate.workLocation,
        acceptanceDeadline: acceptanceDeadline || candidate.acceptanceDeadline,
        hrName: candidate?.hrAssigned?.name || "HR Manager",
        interviewDate: candidate.createdAt ? new Date(candidate.createdAt).toLocaleDateString() : new Date().toLocaleDateString(),
        generationDate: new Date().toLocaleDateString(),
        base64Logo: getBase64Logo()
    };

    return res.status(200).json(new ApiResponse(200, data, "Offer letter data fetched"));
});

// 2. Joining Letter Data
const getJoiningLetterData = asyncHandler(async (req, res) => {
    const { employeeId } = req.params;
    const { joiningDate, workLocation, designation, department } = req.body;

    const employee = await Employee.findById(employeeId).populate("post");
    if (!employee) throw new ApiError(404, "Employee not found");

    const data = {
        employeeName: `${employee.firstName} ${employee.middleName || ''} ${employee.lastName || ''}`,
        designation: designation || employee.post?.title,
        department: department || employee?.post?.department?.name || employee.department,
        joiningDate: joiningDate || employee.joiningDate,
        workLocation: workLocation || employee.workLocation,
        generationDate: new Date().toLocaleDateString(),
        // Company details
        companyName: process.env.COMPANY_NAME || "BIMS Hospital",
        companyAddress: process.env.COMPANY_ADDRESS || "Gandhinagar Pada, Jail Road, Balangir, Odisha, 767001",
        companyWebsite: process.env.COMPANY_WEBSITE || "www.bimshospitals.com",
        companyContact: process.env.COMPANY_PHONE || "8455005505",
        companyEmail: process.env.COMPANY_EMAIL || "hr@bimshospitals.com",
        companyID: process.env.COMPANY_ID || "123456789",
        base64Logo: getBase64Logo()
    };

    return res.status(200).json(new ApiResponse(200, data, "Joining letter data fetched"));
});

// 3. Experience Letter Data
const getExperienceLetterData = asyncHandler(async (req, res) => {
    const { employeeId } = req.params;
    const { startDate, endDate, department, responsibility1, responsibility2, responsibility3 } = req.body;

    const employee = await Employee.findById(employeeId).populate("post");
    if (!employee) throw new ApiError(404, "Employee not found");

    const data = {
        employeeName: `${employee.firstName} ${employee.middleName || ''} ${employee.lastName || ''}`,
        jobTitle: employee.post?.title,
        department: department || employee.department,
        startDate: startDate || employee.joiningDate,
        endDate: endDate || employee.exitDate || new Date().toISOString().split('T')[0],
        employmentType: employee.status || "Full-time",
        pronoun: (employee.gender || 'male') === 'female' ? 'she' : 'he',
        responsibility1: responsibility1 || employee.responsibilities?.[0] || "",
        responsibility2: responsibility2 || employee.responsibilities?.[1] || "",
        responsibility3: responsibility3 || employee.responsibilities?.[2] || "",
        signatoryName: process.env.SIGNATORY_NAME || "HR Manager",
        signatoryTitle: process.env.SIGNATORY_TITLE || "HR Manager",
        generationDate: new Date().toLocaleDateString(),
        
        // --- ADDED THESE MISSING FIELDS ---
                companyName: process.env.COMPANY_NAME || "BIMS Hospital",
        companyAddress: process.env.COMPANY_ADDRESS || "Gandhinagar Pada, Jail Road, Balangir, Odisha, 767001",
        companyWebsite: process.env.COMPANY_WEBSITE || "www.bimshospitals.com",
        companyContact: process.env.COMPANY_PHONE || "8455005505",
        companyEmail: process.env.COMPANY_EMAIL || "hr@bimshospitals.com",
        companyID: process.env.COMPANY_ID || "123456789",
        base64Logo: getBase64Logo()
    };

    return res.status(200).json(new ApiResponse(200, data, "Experience letter data fetched"));
});

// 4. Payroll Slip Data
const getPayrollSlipData = asyncHandler(async (req, res) => {
    const { employeeId } = req.params;
    const { month } = req.body;

    // 1. Fetch Employee with Nested Population
    // We populate 'post', and inside 'post' we populate 'department'
    const employee = await Employee.findById(employeeId).populate({
        path: "post",
        populate: {
            path: "department",
            select: "name" // We only need the name field
        }
    });

    if (!employee) throw new ApiError(404, "Employee not found");

    // 2. Fetch Payroll Record
    const payroll = await Payroll.findOne({ employee: employeeId, month: month });
    
    if (!payroll) throw new ApiError(404, "Payroll data not found for specified month");

    // 3. Construct the Data Object
    const data = {
        // Employee Details
        employeeName: `${employee.firstName} ${employee.middleName || ''} ${employee.lastName || ''}`,
        employeeId: employee.employeeId,
        designation: employee.post?.title || "N/A",
        
        // Accessing the nested department name safely
        department: employee.post?.department?.name || "N/A",
        
        // Payroll Details
        month: payroll.month,
        attendance: payroll.attendance,
        earnings: payroll.earnings,
        deductions: payroll.deductions,
        netSalary: payroll.netSalary,
        netSalaryInWords: convertNumberToWords(payroll.netSalary),
        status: payroll.status,
        generationDate: new Date().toLocaleDateString(),

        // Company Header Details (For the PDF Header)
            companyName: process.env.COMPANY_NAME || "BIMS Hospital",
        companyAddress: process.env.COMPANY_ADDRESS || "Gandhinagar Pada, Jail Road, Balangir, Odisha, 767001",
        companyWebsite: process.env.COMPANY_WEBSITE || "www.bimshospitals.com",
        companyContact: process.env.COMPANY_PHONE || "8455005505",
        companyEmail: process.env.COMPANY_EMAIL || "hr@bimshospitals.com",
        companyID: process.env.COMPANY_ID || "123456789",
        
        // Logo
        base64Logo: getBase64Logo()
    };

    return res.status(200).json(new ApiResponse(200, data, "Payroll data fetched"));
});

export { 
    getOfferLetterData, 
    getJoiningLetterData, 
    getExperienceLetterData, 
    getPayrollSlipData 
};