import express from 'express';
import multer from 'multer';
import { registerFace, updateFace } from '../controllers/face.controller.js';

const faceRouter = express.Router();

// Temp storage for images before uploading to Azure
const upload = multer({ dest: 'uploads/' });

// Route: POST /api/face/register
// Body: FormData { image: (file), employeeId: "mongo_id" }
faceRouter.post('/register', upload.single('image'), registerFace);

// Route: PUT /api/face/update
// Body: FormData { image: (file), employeeId: "mongo_id" }
faceRouter.post('/update', upload.single('image'), updateFace);

export default faceRouter;