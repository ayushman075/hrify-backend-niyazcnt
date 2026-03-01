import express from 'express';
import { 
  fetchBiometricLogs, 
  processBiometricAttendance, 
  getAttendanceSummary 
} from '../controllers/biometricAttendance.controller.js';
import { 
  manualReconciliation, 
  reconcileAttendanceForDateRange 
} from '../services/biometricCron.service.js';
import { asyncHandler } from '../utils/AsyncHandler.js';
import { ApiResponse } from '../utils/ApiResponse.js';

const biometricRouter = express.Router();

// GET /api/biometric/logs - Fetch raw biometric logs
biometricRouter.get('/logs', fetchBiometricLogs);

// POST /api/biometric/process - Process and save biometric attendance
biometricRouter.post('/process', processBiometricAttendance);

// GET /api/biometric/summary - Get attendance summary
biometricRouter.get('/summary', getAttendanceSummary);

// POST /api/biometric/reconcile - Manual reconciliation for a specific date
biometricRouter.post('/reconcile', asyncHandler(async (req, res) => {
  try {
    const { date } = req.body;
    
    if (!date) {
      return res.status(400).json(
        new ApiResponse(400, null, "Date is required", false)
      );
    }

    const result = await manualReconciliation(date);
    
    if (result.success) {
      return res.status(200).json(
        new ApiResponse(200, result, `Attendance reconciliation completed for ${date}`, true)
      );
    } else {
      return res.status(500).json(
        new ApiResponse(500, result, `Attendance reconciliation failed for ${date}`, false)
      );
    }
  } catch (error) {
    console.error("Error in manual reconciliation:", error);
    return res.status(500).json(
      new ApiResponse(500, null, "Error in manual reconciliation", false)
    );
  }
}));

// POST /api/biometric/reconcile-range - Manual reconciliation for date range
biometricRouter.post('/reconcile-range', asyncHandler(async (req, res) => {
  try {
    const { fromDate, toDate } = req.body;
    
    if (!fromDate || !toDate) {
      return res.status(400).json(
        new ApiResponse(400, null, "FromDate and ToDate are required", false)
      );
    }

    const results = await reconcileAttendanceForDateRange(fromDate, toDate);
    
    const summary = {
      totalDays: results.length,
      successfulDays: results.filter(r => r.success).length,
      failedDays: results.filter(r => !r.success).length,
      totalCreated: results.reduce((sum, r) => sum + (r.created || 0), 0),
      totalUpdated: results.reduce((sum, r) => sum + (r.updated || 0), 0),
      totalFailed: results.reduce((sum, r) => sum + (r.failed || 0), 0),
      results
    };
    
    return res.status(200).json(
      new ApiResponse(200, summary, `Attendance reconciliation completed for date range ${fromDate} to ${toDate}`, true)
    );
  } catch (error) {
    console.error("Error in range reconciliation:", error);
    return res.status(500).json(
      new ApiResponse(500, null, "Error in range reconciliation", false)
    );
  }
}));

// GET /api/biometric/test - Test biometric API connection
biometricRouter.get('/test', asyncHandler(async (req, res) => {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const testDate = yesterday.toISOString().split('T')[0];
    
    const axios = (await import('axios')).default;
    const response = await axios.get('https://klcloud.in/bims/api/v2/WebAPI/GetDeviceLogs', {
      params: {
        APIKey: '275412062524',
        FromDate: testDate,
        ToDate: testDate
      }
    });

    return res.status(200).json(
      new ApiResponse(200, {
        status: 'Connected',
        testDate,
        logsCount: response.data.length,
        sampleLogs: response.data.slice(0, 5)
      }, "Biometric API connection successful", true)
    );
  } catch (error) {
    console.error("Error testing biometric API:", error);
    return res.status(500).json(
      new ApiResponse(500, null, "Error connecting to biometric API", false)
    );
  }
}));

export default biometricRouter;