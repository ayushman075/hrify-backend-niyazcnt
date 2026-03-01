import fs from 'fs';
import path from 'path';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { Candidate } from '../models/candidate.model.js';
import { Employee } from '../models/employee.model.js';
import { Payroll } from '../models/payroll.model.js';
import { asyncHandler } from '../utils/AsyncHandler.js';
import dayjs from 'dayjs'; // Utilizing dayjs for clean, consistent date formatting

// ─── Helpers ─────────────────────────────────────────────────────────────────

const getBase64Logo = () => {
    try {
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

const formatDate = (date) => (date ? dayjs(date).format('DD MMM YYYY') : 'N/A');

// ─── Controllers ─────────────────────────────────────────────────────────────

// 1. Offer Letter Data
const getOfferLetterData = asyncHandler(async (req, res) => {
    const { candidateId } = req.params;
    // Allow overriding from frontend via body if necessary
    const { acceptanceDeadline } = req.body; 

    // Deep populate Post and Department
    const candidate = await Candidate.findById(candidateId)
        .populate({
            path: 'post',
            populate: { path: 'department', select: 'name' }
        })
        .lean();

    if (!candidate) throw new ApiError(404, "Candidate not found");
    if (!candidate.post) throw new ApiError(400, "Incomplete data: Candidate has no associated Post");

    const data = {
        candidateName: candidate.name,
        jobTitle: candidate.post.title || "N/A",
        
        // Exact Requirements Mapped:
        department: candidate.post.department?.name || "N/A", 
        joiningDate: formatDate(candidate.appointmentDate),    
        salaryDetails: candidate.post.salary?.total || 0,     
        workLocation: candidate.post.location || "N/A",       

        acceptanceDeadline: acceptanceDeadline || formatDate(dayjs().add(7, 'day')), 
        hrName: "HR Manager", 
        generationDate: dayjs().format('DD MMM YYYY'),
        
        // Company Details
        companyName: process.env.COMPANY_NAME || "BIMS Hospital",
        companyAddress: process.env.COMPANY_ADDRESS || "Gandhinagar Pada, Jail Road, Balangir, Odisha, 767001",
        companyWebsite: process.env.COMPANY_WEBSITE || "www.bimshospitals.com",
        companyContact: process.env.COMPANY_PHONE || "8455005505",
        companyEmail: process.env.COMPANY_EMAIL || "hr@bimshospitals.com",
        companyID: process.env.COMPANY_ID || "123456789",
        base64Logo: getBase64Logo()
    };

    return res.status(200).json(new ApiResponse(200, data, "Offer letter data fetched"));
});

// 2. Joining Letter Data
const getJoiningLetterData = asyncHandler(async (req, res) => {
    const { employeeId } = req.params;

    // Deep populate Post and Department
    const employee = await Employee.findById(employeeId)
        .populate({
            path: 'post',
            populate: { path: 'department', select: 'name' }
        })
        .lean();

    if (!employee) throw new ApiError(404, "Employee not found");
    if (!employee.post) throw new ApiError(400, "Incomplete data: Employee has no associated Post");

    const data = {
        employeeName: `${employee.firstName} ${employee.middleName || ''} ${employee.lastName || ''}`.trim(),
        
        // Exact Requirements Mapped:
        designation: employee.post.title || "N/A",           
        department: employee.post.department?.name || "N/A", 
        joiningDate: formatDate(employee.dateOfJoining),     
        workLocation: employee.post.location || "N/A",       
        
        employeeCode: employee.employeeId,
        employmentType: employee.employmentType || "FullTime",
        generationDate: dayjs().format('DD MMM YYYY'),
        
        // Company Details
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
    
    // Front-end overrides for responsibilities
    const { responsibility1, responsibility2, responsibility3 } = req.body;

    const employee = await Employee.findById(employeeId)
        .populate({
            path: 'post',
            populate: { path: 'department', select: 'name' }
        })
        .lean();

    if (!employee) throw new ApiError(404, "Employee not found");

    const data = {
        employeeName: `${employee.firstName} ${employee.middleName || ''} ${employee.lastName || ''}`.trim(),
        employeeCode: employee.employeeId,
        jobTitle: employee.post?.title || "N/A",
        
        // Exact Requirements Mapped:
        department: employee.post?.department?.name || "N/A", 
        startDate: formatDate(employee.dateOfJoining),        
        
        endDate: employee.lastWorkingDate ? formatDate(employee.lastWorkingDate) : formatDate(dayjs()),
        employmentType: employee.employmentType || "FullTime",
        pronoun: (employee.gender || 'Male').toLowerCase() === 'female' ? 'she' : 'he',
        
        responsibility1: responsibility1 || "Handled core operational tasks efficiently",
        responsibility2: responsibility2 || "Collaborated with the team to meet project goals",
        responsibility3: responsibility3 || "Maintained high standards of professional conduct",
        
        signatoryName: process.env.SIGNATORY_NAME || "HR Manager",
        signatoryTitle: process.env.SIGNATORY_TITLE || "Human Resources",
        generationDate: dayjs().format('DD MMM YYYY'),
        
        // Company Details
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
    const { month } = req.query; // Usually passed as query param in GET requests

    if (!month) throw new ApiError(400, "Payroll month is required");

    const employee = await Employee.findById(employeeId)
        .populate({
            path: "post",
            populate: { path: "department", select: "name" }
        })
        .lean();

    if (!employee) throw new ApiError(404, "Employee not found");

    const payroll = await Payroll.findOne({ employee: employeeId, period: month }).lean();
    if (!payroll) throw new ApiError(404, `Payroll data not found for ${month}`);

    const data = {
        employeeName: `${employee.firstName} ${employee.middleName || ''} ${employee.lastName || ''}`.trim(),
        employeeId: employee.employeeId,
        designation: employee.post?.title || "N/A",
        department: employee.post?.department?.name || "N/A",
        
        month: payroll.period || payroll.month,
        type: payroll.type, // Monthly or Weekly
        attendance: payroll.attendance || {},
        earnings: payroll.earnings || {},
        deductions: payroll.deductions || {},
        employerContributions: payroll.employerContributions || {},
        netSalary: payroll.netSalary || 0,
        netSalaryInWords: convertNumberToWords(payroll.netSalary || 0),
        status: payroll.status,
        generationDate: dayjs().format('DD MMM YYYY'),

        // Company Header Details
        companyName: process.env.COMPANY_NAME || "BIMS Hospital",
        companyAddress: process.env.COMPANY_ADDRESS || "Gandhinagar Pada, Jail Road, Balangir, Odisha, 767001",
        companyWebsite: process.env.COMPANY_WEBSITE || "www.bimshospitals.com",
        companyContact: process.env.COMPANY_PHONE || "8455005505",
        companyEmail: process.env.COMPANY_EMAIL || "hr@bimshospitals.com",
        companyID: process.env.COMPANY_ID || "123456789",
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