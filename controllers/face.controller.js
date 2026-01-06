import { Employee } from "../models/employee.model.js";
import { User } from "../models/user.model.js";
import fs from "fs";
import { 
    addFaceToAzurePerson, 
    createAzurePerson, 
    removeFaceFromAzurePerson, // Imported new service
    trainAzureGroup 
} from "../services/azureFace.service.js";
import { removeCachePattern } from "../utils/cache.js";

// =========================================
// 1. Register New Face (First Time)
// ==========================================
export const registerFace = async (req, res) => {
    try {
        const { employeeId } = req.body;
        const file = req.file;

        // 1. Validation
        if (!file) {
            return res.status(400).json({ message: "Image file is required." });
        }
        if (!employeeId) {
            return res.status(400).json({ message: "Employee ID is required." });
        }

        // 2. Find Employee
        const employee = await Employee.findById(employeeId);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found." });
        }

        // 3. Azure: Create Person ID
        const nameLabel = `${employee.firstName} ${employee.lastName}`;
        const azurePersonId = await createAzurePerson(nameLabel);

        // 4. Azure: Add Face & GET TOKEN
        const faceToken = await addFaceToAzurePerson(azurePersonId, file.path);

        // 5. Azure: Train (No-op for Face++, but good practice)
        await trainAzureGroup();

        // 6. DB Update: Employee Model
        employee.azurePersonId = azurePersonId;
        employee.faceToken = faceToken; // *** SAVING THE TOKEN ***
        employee.isFaceRegistered = true;
        await employee.save();

        // 7. DB Update: User Model (Sync Logic)
        const userUpdate = await User.findOneAndUpdate(
            { employeeId: employee._id },
            { azurePersonId: azurePersonId }
        );

        await removeCachePattern(`employee_list_*`);

        res.status(200).json({ 
            success: true, 
            message: "Face registered successfully.",
            azurePersonId: azurePersonId,
            faceToken: faceToken,
            userLinked: !!userUpdate
        });

    } catch (error) {
        console.error("Register Face Error:", error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
    }
};

// ==========================================
// 2. Update Face (Delete Old -> Add New)
// ==========================================
export const updateFace = async (req, res) => {
    try {
        const { employeeId } = req.body;
        const file = req.file;

        if (!file || !employeeId) {
            return res.status(400).json({ message: "Data missing." });
        }

        // 1. Find Employee
        // Use .select() to ensure we get the hidden fields if they are select:false in schema
        const employee = await Employee.findById(employeeId).select('+azurePersonId +faceToken');

        if (!employee || !employee.azurePersonId) {
            return res.status(404).json({ 
                message: "Employee not found or face not registered yet. Please use Register first." 
            });
        }

        // 2. Remove Old Face (if token exists)
        if (employee.faceToken) {
            await removeFaceFromAzurePerson(employee.faceToken);
        }

        // 3. Add New Face & Get New Token
        // We reuse the existing azurePersonId
        const newFaceToken = await addFaceToAzurePerson(employee.azurePersonId, file.path);

        // 4. Update Database
        employee.faceToken = newFaceToken; 
        await employee.save();

        await removeCachePattern(`employee_list_*`);

        res.status(200).json({ 
            success: true, 
            message: "Face model updated successfully. Old face removed.",
            faceToken: newFaceToken
        });

    } catch (error) {
        console.error("Update Face Error:", error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
    }
};