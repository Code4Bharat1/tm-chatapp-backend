import express from "express"
import { getLogginUser, getMessagesByRoom, getRooms, getUsersByCompany, handleDeleteRoom } from "../controller/message.controller.js";
import { deleteFile , downloadFile, getFilesByRoom, uploadFile , uploadMiddleware } from "../controller/filleController.js";
import { deleteVoice, downloadVoice, getAllCompanyVoices, uploadVoice , voiceUploadMiddleware } from "../controller/voiceController.js";
import authMiddleware from "../middleware/auth.middleware.js";
const router = express.Router();

router.get("/user", authMiddleware , getLogginUser)
router.get("/companyUsers" , authMiddleware , getUsersByCompany)
router.get("/messages", authMiddleware, getMessagesByRoom);
router.get("/rooms" , authMiddleware , getRooms)


//room delete 
router.delete("/delete/room/:roomId" , authMiddleware , handleDeleteRoom)

//file upload and download
router.post("/upload" , authMiddleware , uploadMiddleware , uploadFile)
router.get("/download/:fileID" , authMiddleware  , downloadFile)
router.delete("/delete/file/:fileID" , authMiddleware , deleteFile  ) // delete one file 
router.get("/get/file/:roomId" , authMiddleware , getFilesByRoom) 

//voice upload and download
router.post("/upload/voice",authMiddleware , voiceUploadMiddleware , uploadVoice)
router.get("/download/voice/:voiceId" , authMiddleware ,downloadVoice)
router.delete("/delete/voice/:voiceId" , authMiddleware , deleteVoice ) // delete one voice file
router.get("/get/voice/:roomId" , authMiddleware , getAllCompanyVoices ) // delete all voice file of that roomes
export default router ;