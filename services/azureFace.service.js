import { 
    RekognitionClient, 
    IndexFacesCommand, 
    SearchFacesByImageCommand,
    DeleteFacesCommand
} from "@aws-sdk/client-rekognition";
import fs from "fs/promises";
import dotenv from 'dotenv';

// 👇 IMPORT EMPLOYEE MODEL (Required for Duplicate Check)
import { Employee } from "../models/employee.model.js"; 

dotenv.config();

const client = new RekognitionClient({ 
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const COLLECTION_ID = "hrify-employees-group-v2";

// =========================================================
// 1. IDENTIFY USER (For Attendance)
// =========================================================
export const identifyUserFromFace = async (imagePath) => {
    try {
        const imageBytes = await fs.readFile(imagePath);

        const command = new SearchFacesByImageCommand({
            CollectionId: COLLECTION_ID,
            Image: { Bytes: imageBytes },
            MaxFaces: 1,
            FaceMatchThreshold: 80
        });

        const response = await client.send(command);

        if (!response.FaceMatches || response.FaceMatches.length === 0) {
            return { identified: false, reason: "Face not recognized" };
        }

        return {
            identified: true,
            azurePersonId: response.FaceMatches[0].Face.ExternalImageId, 
            confidence: response.FaceMatches[0].Similarity
        };

    } catch (error) {
        // --- HANDLE LOGICAL ERRORS (Return 200 Friendly Responses) ---
        
        // 1. No faces in image (User uploaded a wall/blank photo)
        if (error.name === 'InvalidParameterException' && error.message.includes('no faces')) {
            return { identified: false, reason: "No face detected in the image." };
        }

        // 2. Collection doesn't exist yet (First run)
        if (error.name === 'ResourceNotFoundException') {
            return { identified: false, reason: "System empty (No faces registered yet)." };
        }

        // 3. File is not an image
        if (error.name === 'InvalidImageFormatException') {
            return { identified: false, reason: "Invalid image format." };
        }

        // --- HANDLE SYSTEM ERRORS (Throw 500) ---
        console.error("AWS System Error:", error); 
        throw new Error(`AWS Error: ${error.message}`);
    }
};

// =========================================================
// 2. ADD FACE (Registration - With Duplicate Check)
// =========================================================
export const addFaceToAzurePerson = async (personId, imagePath) => {
    try {
        const imageBytes = await fs.readFile(imagePath);

        // --- STEP A: CHECK FOR DUPLICATES ---
        // We run a search before adding. If this face exists, we block it.
        const searchCommand = new SearchFacesByImageCommand({
            CollectionId: COLLECTION_ID,
            Image: { Bytes: imageBytes },
            MaxFaces: 1,
            FaceMatchThreshold: 95 // Very High threshold to ensure it's definitely the same person
        });

        let duplicateFound = null;
        try {
            const searchResponse = await client.send(searchCommand);
            if (searchResponse.FaceMatches && searchResponse.FaceMatches.length > 0) {
                duplicateFound = searchResponse.FaceMatches[0].Face.ExternalImageId;
            }
        } catch (err) {
            // Ignore errors here (e.g. if collection doesn't exist yet, we just proceed to add)
        }

        // --- STEP B: IF DUPLICATE FOUND, FETCH OWNER & THROW ERROR ---
        if (duplicateFound) {
            // 1. Find who owns this face in MongoDB
            const existingEmployee = await Employee.findOne({ azurePersonId: duplicateFound });

            if (existingEmployee) {
                // 2. Construct the specific error message
                const code = existingEmployee.employeeId || "NoID"; 
                const name = `${existingEmployee.firstName} ${existingEmployee.lastName || ""}`.trim();
                
                // 3. Throw Error (Controller will catch this and send to frontend)
                throw new Error(`This face is already attached to ${code} - ${name}`);
            }
        }

        // --- STEP C: PROCEED TO ADD (If unique) ---
        const safePersonId = String(personId).replace(/[^a-zA-Z0-9_.\-]/g, "_");

        const indexCommand = new IndexFacesCommand({
            CollectionId: COLLECTION_ID,
            Image: { Bytes: imageBytes },
            ExternalImageId: safePersonId,
            DetectionAttributes: ["ALL"]
        });

        const response = await client.send(indexCommand);
        
        if (!response.FaceRecords || response.FaceRecords.length === 0) {
            throw new Error("No face detected in image");
        }
        
        return response.FaceRecords[0].Face.FaceId;

    } catch (error) {
        // If it's our custom duplicate error, re-throw it directly so the message stays intact
        if (error.message.includes("already attached")) {
            throw error;
        }
        throw new Error(`AWS Add Error: ${error.message}`);
    }
};

// =========================================================
// 3. HELPER FUNCTIONS
// =========================================================

export const createAzurePerson = async (name) => {
    // Generates a unique ID string for AWS ExternalImageId
    return `user_${Date.now()}_${Math.floor(Math.random() * 1000)}`; 
};

export const removeFaceFromAzurePerson = async (faceToken) => {
    if (!faceToken) return;
    try { 
        await client.send(new DeleteFacesCommand({ 
            CollectionId: COLLECTION_ID, 
            FaceIds: [faceToken] 
        })); 
        return true; 
    } catch (e) { 
        return false; 
    }
};

// No-op for AWS (Indexing is automatic)
export const trainAzureGroup = async () => { return true; };