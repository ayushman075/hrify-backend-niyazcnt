
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/AsyncHandler.js";
import EmailTemplate from "../models/emailTemplate.model.js";
import { EmailLog } from "../models/emailLog.model.js";
import { User } from "../models/user.model.js";
import { emailQueue } from "../db/redis.config.js";

const sendTemplateEmail = asyncHandler(async (req, res) => {
    const { templateId, to, variables, priority } = req.body;
    
    if (!templateId || !to ) {
      return res.status(400).json(new ApiResponse(400, {}, "Template ID, recipient, and variables are required"));
    }
    
    // Verify if the user is authorized
    const userId = req.auth.userId;
    if (!userId) {
      return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
    }
    
    // Find the user
    const user = await User.findOne({ userId });
    if (!user) {
      return res.status(404).json(new ApiResponse(404, {}, "User not found", false));
    }
    
    // Find the template
    const template = await EmailTemplate.findById(templateId);
    if (!template) {
      return res.status(404).json(new ApiResponse(404, {}, "Email template not found", false));
    }
    
    
    // Verify that all required variables are provided
    const templateVars = template.variables || [];
    const missingVars = templateVars.filter(varName => !variables.hasOwnProperty(varName));
    
    if (missingVars.length > 0) {
      return res.status(400).json(
        new ApiResponse(400, { missingVariables: missingVars }, 
          `Missing required variables: ${missingVars.join(', ')}`, false)
      );
    }
    
    // Replace variables in the template subject and body
    let subject = template.subject;
    let html = template.body;
    let text = template.body; // Plain text version
    
    // Replace all variables in the template with their values
    Object.keys(variables).forEach(varName => {
      const regex = new RegExp(`\\{\\{${varName}\\}\\}`, 'g');
      subject = subject.replace(regex, variables[varName]);
      html = html.replace(regex, variables[varName]);
      text = text.replace(regex, variables[varName]);
    });
    
    // Strip HTML tags for text version
    text = text.replace(/<[^>]*>?/gm, '');
    
    // Create an entry in the EmailLog collection
    const emailLog = await EmailLog.create({
      template: templateId,
      to,
      subject,
      variables,
      sentBy: user._id,
      status: 'queued',
      priority: priority || 'normal',
    });
    
    // Prepare request options for the email queue
    const requestOption = {
      to,
      subject,
      text,
      html,
      metadata: {
        logId: emailLog._id,
        userId: user._id,
        templateId
      }
    };
    
    // Add to email queue
    try {
      const jobOptions = {
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 3, 
        priority: priority === 'high' ? 1 : priority === 'low' ? 10 : 5 // Set job priority
      };
      
      await emailQueue.add('email', requestOption, jobOptions);
      
      return res.status(200).json(
        new ApiResponse(200, { emailId: emailLog._id }, "Email queued successfully")
      );
    } catch (error) {
      // Update the email log status to 'failed'
      await EmailLog.findByIdAndUpdate(emailLog._id, { status: 'failed', error: error.message });
      
      return res.status(500).json(
        new ApiResponse(500, {}, `Failed to queue email: ${error.message}`, false)
      );
    }
  });
  
  /**
   * Controller to get email logs with advanced filtering and pagination
   */
  const getEmailLogs = asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 20,
      status,
      templateId,
      startDate,
      endDate,
      recipient,
      sentBy,
      sort = '-createdAt'
    } = req.query;
    
    const userId = req.auth.userId;
    if (!userId) {
      return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
    }
  
    const user = await User.findOne({ userId });
    if (!user) {
      return res.status(404).json(new ApiResponse(404, {}, "User not found", false));
    }
  

  
    // Build filter conditions
    const query = {};
    if (sentBy) {
      query.sentBy = sentBy;
    }
  
    if (status) {
      query.status = status;
    }
  
    if (templateId) {
      query.template = templateId;
    }
  
    if (recipient) {
      query.to = { $regex: recipient, $options: 'i' };
    }
  
    // Date range filter
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        query.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        // Add one day to include the end date fully
        const nextDay = new Date(endDate);
        nextDay.setDate(nextDay.getDate() + 1);
        query.createdAt.$lt = nextDay;
      }
    }
  
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const logs = await EmailLog.find(query)
      .populate('template', 'name subject')
      .populate('sentBy', 'name email')
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));
  
    const totalLogs = await EmailLog.countDocuments(query);
  
    return res.status(200).json(new ApiResponse(200, {
      totalLogs,
      totalPages: Math.ceil(totalLogs / parseInt(limit)),
      currentPage: parseInt(page),
      logs,
    }, "Email logs fetched successfully!"));
  });
  
  /**
   * Controller to get details of a specific email
   */
  const getEmailDetails = asyncHandler(async (req, res) => {
    const { emailId } = req.params;
    
    const userId = req.auth.userId;
    if (!userId) {
      return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
    }
  
    const user = await User.findOne({ userId });
    if (!user) {
      return res.status(404).json(new ApiResponse(404, {}, "User not found", false));
    }
  
    const email = await EmailLog.findById(emailId)
      .populate('template', 'name subject body variables')
      .populate('sentBy', 'name email');
  
    if (!email) {
      return res.status(404).json(new ApiResponse(404, {}, "Email not found", false));
    }
  

  
    return res.status(200).json(new ApiResponse(200, email, "Email details fetched successfully!"));
  });
  
  
  /**
   * Controller to get email statistics
   */
  const getEmailStats = asyncHandler(async (req, res) => {
    const { period = 'week' } = req.query;
    
    const userId = req.auth.userId;
    if (!userId) {
      return res.status(401).json(new ApiResponse(401, {}, "Unauthorized Request", false));
    }
  
    const user = await User.findOne({ userId });
    if (!user) {
      return res.status(404).json(new ApiResponse(404, {}, "User not found", false));
    }
  
    // Only admins can see overall stats
    if (user.role !== 'Admin') {
      return res.status(403).json(new ApiResponse(403, {}, "Only admins can view email statistics", false));
    }
  
    // Set date range based on period
    let startDate = new Date();
    if (period === 'day') {
      startDate.setDate(startDate.getDate() - 1);
    } else if (period === 'week') {
      startDate.setDate(startDate.getDate() - 7);
    } else if (period === 'month') {
      startDate.setMonth(startDate.getMonth() - 1);
    } else if (period === 'year') {
      startDate.setFullYear(startDate.getFullYear() - 1);
    }
  
    // Get counts by status
    const statusStats = await EmailLog.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
  
    // Get template usage
    const templateStats = await EmailLog.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      { $group: { _id: '$template', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
      { $lookup: { from: 'emailtemplates', localField: '_id', foreignField: '_id', as: 'templateInfo' } },
      { $unwind: '$templateInfo' },
      { $project: { name: '$templateInfo.name', count: 1 } }
    ]);
  
    // Get daily email counts
    const dailyStats = await EmailLog.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ]);
  
    // Format daily stats for chart display
    const formattedDailyStats = dailyStats.map(stat => ({
      date: `${stat._id.year}-${stat._id.month.toString().padStart(2, '0')}-${stat._id.day.toString().padStart(2, '0')}`,
      count: stat.count
    }));
  
    // Convert status stats to object
    const statusCounts = statusStats.reduce((acc, stat) => {
      acc[stat._id] = stat.count;
      return acc;
    }, {});
  
    const stats = {
      totalEmails: statusStats.reduce((sum, stat) => sum + stat.count, 0),
      statusCounts,
      topTemplates: templateStats,
      dailyStats: formattedDailyStats
    };
  
    return res.status(200).json(new ApiResponse(200, stats, "Email statistics fetched successfully!"));
  });
  
  // Export controllers
export {
    sendTemplateEmail,
    getEmailLogs,
    getEmailDetails,
    getEmailStats
  };