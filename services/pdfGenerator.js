import puppeteer from 'puppeteer';
import fs from 'fs'
import path from 'path';
import Handlebars from 'handlebars';
import { uploadFileOnCloudinary } from '../utils/cloudinary.js';
import dotenv from 'dotenv'
import PDFLog from '../models/pdfGeneration.model.js';

dotenv.config({
  path:'.env'
});



// ----------- Development Puppeteer Config ----------- 




const puppeteerConfig = {
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true,
    timeout: 60000
}




// ----------- Development Puppeteer Config ----------- 




// ----------- Production Puppeteer Config ----------- 




// const puppeteerConfig = {
//   executablePath:process.removeListener.NODE_ENV==="production"?process.env.PUPPETEER_EXCECUTABLE_PATH:puppeteer.executablePath(),
//   args: ['--no-sandbox', '--disable-setuid-sandbox',"--single-process","--no-zygote"],
//   headless: true,
//   timeout: 60000
// }



// ----------- Production Puppeteer Config ----------- 




const base64Encode = (file) => {
    const bitmap = fs.readFileSync(file);
    return Buffer.from(bitmap).toString('base64');
};

// Function to generate PDF
async function generateOfferLetterPDF(candidateData) {
  const {
    candidateName,
    jobTitle,
    companyName,
    joiningDate,
    salaryDetails,
    workLocation,
    acceptanceDeadline,
    hrName,
    candidateId,
    generationDate= new Date().toLocaleDateString()
  } = candidateData;

  // HTML Template
  const templatePath =  './templates/offerLetter.html';
  const templateHTML = fs.readFileSync(templatePath, 'utf8');
try{
  // Compile the Handlebars template
  const startTime = new Date();
  console.log(`---------- Offer_Letter_${candidateId}_${new Date()}.pdf Generation start ----------`)
  console.log(`PDF generation stared at ${startTime}`)
  const template = Handlebars.compile(templateHTML);
  const base64Logo = base64Encode( './assests/bimsLogo.png');
  const html = template({...candidateData, base64Logo});


  const browser = await puppeteer.launch(puppeteerConfig);
  const puppeteerlaunchTime = new Date();
  console.log(`Puppeteer launched at ${puppeteerlaunchTime-startTime}`)


  const page = await browser.newPage();

  await page.setContent(html, { waitUntil: 'domcontentloaded',timeout:20000 });
  await page.setJavaScriptEnabled(false);
  await page.emulateMediaType('screen');
  const contentsetTime = new Date();
  console.log(`Content set at ${contentsetTime-puppeteerlaunchTime}`)
  const pdfPath = `./public/uploads/Offer_Letter_${candidateId}.pdf`;
  const pdfsetTime = new Date();
  console.log(`PDF set at ${pdfsetTime-contentsetTime}`)
 
  await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      timeout:90000
  });

 
  await browser.close();
  
  const pdfsaveTime = new Date();
  console.log(`PDF saved at ${pdfsaveTime-pdfsetTime}`)

  const uploadedLink = await uploadFileOnCloudinary(pdfPath);

  const pdfuploadTime = new Date();
  console.log(`PDF saved at ${pdfuploadTime-pdfsaveTime}`)


  await PDFLog.create({
    name:`Offer_Letter_${candidateId}`,
    documentType:'offerLetter',
    url:uploadedLink,
    employeeName:candidateName
  })

  //fs.unlinkSync(pdfPath);
 // console.log(`PDF Sent ${workOrderNumber}`)
 console.log(`PDF generation ended. Duration -  ${new Date()-startTime}`)

 console.log(`---------- Offer_Letter_${candidateId}.pdf Generation end ----------`)

// return res.status(200).json(new ApiResponse(200,{workOrder:response,tyreDetail:tyreDetails},"Work Order sent sucessfully !!",true));



  } catch (error) {
    console.error('Error generating Offer Letter PDF :', error);
    throw error;
  }
}

async function generateJoiningLetterPDF(employeeData) {
  const {
    employeeName,
    designation,
    department,
    companyName,
    joiningDate,
    salary,
    workLocation,
    employeeId,
    generationDate= new Date().toLocaleDateString()
  } = employeeData;
  
  

   // HTML Template Path
   const templatePath = './templates/joiningLetter.html';
   const templateHTML = fs.readFileSync(templatePath, 'utf8');
   try{
    // Compile the Handlebars template
    const startTime = new Date();
    console.log(`---------- Joining_Letter_${employeeId}_${new Date()}.pdf Generation start ----------`)
    console.log(`PDF generation stared at ${startTime}`)
    const template = Handlebars.compile(templateHTML);
    const base64Logo = base64Encode( './assests/bimsLogo.png');
    const html = template({...employeeData, base64Logo});
  
  
    const browser = await puppeteer.launch(puppeteerConfig);
    const puppeteerlaunchTime = new Date();
    console.log(`Puppeteer launched at ${puppeteerlaunchTime-startTime}`)
  
  
    const page = await browser.newPage();
  
    await page.setContent(html, { waitUntil: 'domcontentloaded',timeout:20000 });
    await page.setJavaScriptEnabled(false);
    await page.emulateMediaType('screen');
    const contentsetTime = new Date();
    console.log(`Content set at ${contentsetTime-puppeteerlaunchTime}`)
    const pdfPath = `./public/uploads/Joining_Letter_${employeeId}.pdf`;
    const pdfsetTime = new Date();
    console.log(`PDF set at ${pdfsetTime-contentsetTime}`)
   
    await page.pdf({
        path: pdfPath,
        format: 'A4',
        printBackground: true,
        timeout:90000
    });
  
   
    await browser.close();
    
    const pdfsaveTime = new Date();
    console.log(`PDF saved at ${pdfsaveTime-pdfsetTime}`)
  
    const uploadedLink = await uploadFileOnCloudinary(pdfPath);
  
    const pdfuploadTime = new Date();
    console.log(`PDF saved at ${pdfuploadTime-pdfsaveTime}`)
  
  
    await PDFLog.create({
      name:`Joining_Letter_${employeeId}`,
      documentType:'joiningLetter',
      url:uploadedLink,
      employeeName:employeeName
    })
  
    //fs.unlinkSync(pdfPath);
   // console.log(`PDF Sent ${workOrderNumber}`)
   console.log(`PDF generation ended. Duration -  ${new Date()-startTime}`)
  
   console.log(`---------- Joining_Letter_${employeeId}.pdf Generation end ----------`)
  
  // return res.status(200).json(new ApiResponse(200,{workOrder:response,tyreDetail:tyreDetails},"Work Order sent sucessfully !!",true));
  
  
  
    } catch (error) {
      console.error('Error generating PDF:', error);
      throw error;
    }
}





async function generateExperienceLetterPDF(employeeData) {
  const {
    employeeName,
    jobTitle,
    department,
    companyName,
    startDate,
    endDate,
    employmentType,
    employeeId,
    generationDate = new Date().toLocaleDateString()
  } = employeeData;
  
  // HTML Template Path
  const templatePath = './templates/experienceLetter.html';
  const templateHTML = fs.readFileSync(templatePath, 'utf8');
  
  try {
    // Compile the Handlebars template
    const startTime = new Date();
    console.log(`---------- Experience_Letter_${employeeId}_${new Date()}.pdf Generation start ----------`)
    console.log(`PDF generation started at ${startTime}`)
    
    const template = Handlebars.compile(templateHTML);
    const base64Logo = base64Encode('./assests/bimsLogo.png');
    const html = template({
      ...employeeData, 
      base64Logo,
      pronoun: employeeData.gender === 'female' ? 'she' : 'he',
      responsibility1: employeeData.responsibility1 || 'Key responsibility 1',
      responsibility2: employeeData.responsibility2 || 'Key responsibility 2',
      responsibility3: employeeData.responsibility3 || 'Key responsibility 3'
    });
  
    const browser = await puppeteer.launch(puppeteerConfig);
    const puppeteerlaunchTime = new Date();
    console.log(`Puppeteer launched at ${puppeteerlaunchTime-startTime}`)
  
    const page = await browser.newPage();
  
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.setJavaScriptEnabled(false);
    await page.emulateMediaType('screen');
    const contentsetTime = new Date();
    console.log(`Content set at ${contentsetTime-puppeteerlaunchTime}`)
    
    const pdfPath = `./public/uploads/Experience_Letter_${employeeId}.pdf`;
    const pdfsetTime = new Date();
    console.log(`PDF set at ${pdfsetTime-contentsetTime}`)
   
    await page.pdf({
        path: pdfPath,
        format: 'A4',
        printBackground: true,
        timeout: 90000
    });
  
    await browser.close();
    
    const pdfsaveTime = new Date();
    console.log(`PDF saved at ${pdfsaveTime-pdfsetTime}`)
  
    const uploadedLink = await uploadFileOnCloudinary(pdfPath);
  
    const pdfuploadTime = new Date();
    console.log(`PDF uploaded at ${pdfuploadTime-pdfsaveTime}`)
  
    console.log(`PDF generation ended. Duration - ${new Date()-startTime}`)
  

    await PDFLog.create({
      name:`Experience_Letter_${employeeId}`,
      documentType:'experienceLetter',
      url:uploadedLink,
      employeeName:employeeName
    })
    

    console.log(`---------- Experience_Letter_${employeeId}.pdf Generation end ----------`)
  
    return uploadedLink;
  
  } catch (error) {
    console.error('Error generating PDF:', error);
    throw error;
  }
}


async function generatePayrollPDF(payrollData) {
  const {
    employeeName,
    employeeId,
    designation,
    department,
    companyName,
    month,
    payPeriod,
    bankAccount,
    panNumber,
    attendance,
    earnings,
    deductions,
    netSalary,
    netSalaryInWords,
    status,
    generationDate = new Date().toLocaleDateString()
  } = payrollData;
  
  // HTML Template Path
  const templatePath = './templates/payroll.html';
  const templateHTML = fs.readFileSync(templatePath, 'utf8');
  
  try {
    // Compile the Handlebars template
    const startTime = new Date();
    console.log(`---------- Salary_Slip_${employeeId}_${month}_${new Date()}.pdf Generation start ----------`)
    console.log(`PDF generation started at ${startTime}`)
    
    const template = Handlebars.compile(templateHTML);
    const base64Logo = base64Encode('./assests/bimsLogo.png');
    const html = template({
      ...payrollData,
      base64Logo,
      companyAddress: 'Your Company Address',
      companyWebsite: 'www.example.com',
      companyPhone: '123-456-7890',
      companyEmail: 'contact@example.com',
      companyId: '123456789'
    });

    const browser = await puppeteer.launch(puppeteerConfig);
    const puppeteerLaunchTime = new Date();
    console.log(`Puppeteer launched at ${puppeteerLaunchTime-startTime}ms`)

    const page = await browser.newPage();

    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.setJavaScriptEnabled(false);
    await page.emulateMediaType('screen');
    
    const contentSetTime = new Date();
    console.log(`Content set at ${contentSetTime-puppeteerLaunchTime}ms`)
    
    const pdfPath = `./public/uploads/Salary_Slip_${employeeId}_${month.replace(' ', '_')}.pdf`;
    const pdfSetTime = new Date();
    console.log(`PDF set at ${pdfSetTime-contentSetTime}ms`)
   
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      timeout: 90000
    });
   
    await browser.close();
    
    const pdfSaveTime = new Date();
    console.log(`PDF saved at ${pdfSaveTime-pdfSetTime}ms`)

    const uploadedLink = await uploadFileOnCloudinary(pdfPath);

    const pdfUploadTime = new Date();
    console.log(`PDF uploaded at ${pdfUploadTime-pdfSaveTime}ms`)

    await PDFLog.create({
      name: `Salary_Slip_${employeeId}_${month.replace(' ', '_')}`,
      documentType: 'salarySlip',
      url: uploadedLink,
      employeeName: employeeName
    });

    fs.unlinkSync(pdfPath);
    console.log(`PDF generation ended. Duration - ${new Date()-startTime}ms`)
    console.log(`---------- Salary_Slip_${employeeId}_${month}.pdf Generation end ----------`)

    return uploadedLink;
  } catch (error) {
    console.error('Error generating payroll PDF:', error);
    throw error;
  }
}

// // Example Usage
// const employeeData = {
//   employeeName: 'Alex Rodriguez',
//   jobTitle: 'Senior Software Engineer',
//   department: 'Engineering',
//   companyName: 'TechInnovate Solutions',
//   startDate: '2022-01-15',
//   endDate: '2024-01-15',
//   employmentType: 'Full-time',
//   employeeId: 'EMP12345',
//   gender: 'male',
//   responsibility1: 'Led software development team of 5 engineers',
//   responsibility2: 'Developed and maintained critical backend systems',
//   responsibility3: 'Implemented CI/CD pipelines to improve deployment efficiency',
//   signatoryName: 'Jane Smith',
//   signatoryTitle: 'HR Director'
// };

// // Call the function
// generateExperienceLetterPDF(employeeData)






// Example Usage
// const employeeData = {
//   employeeName: 'Alex Rodriguez',
//   designation: 'Senior Software Engineer',
//   department: 'Engineering',
//   companyName: 'TechInnovate Solutions',
//   joiningDate: '2024-03-01',
//   salary: '₹1,200,000 per annum',
//   workLocation: 'Bangalore',
//   employeeId: 'EMP12345'
// };

// // Call the function
// generateJoiningLetterPDF(employeeData)




// Example usage
// generateOfferLetterPDF({
//   candidateName: 'John Doe',
//   jobTitle: 'Software Engineer',
//   companyName: 'TechCorp',
//   joiningDate: '2024-02-01',
//   salaryDetails: '$80,000 per annum',
//   workLocation: 'Remote',
//   acceptanceDeadline: '2024-01-15',
//   department:"Accounts",
//   hrName: 'Jane Smith',
//   candidateId:100006
// });


export {generateOfferLetterPDF,generateJoiningLetterPDF,generateExperienceLetterPDF,generatePayrollPDF}