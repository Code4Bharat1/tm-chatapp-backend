import express from "express"
import { getLogginUser, getMessagesByRoom, getRooms, getUsersByCompany, handleDeleteRoom } from "../controller/message.controller.js";
import { deleteFile , downloadFile, getFilesByRoom, uploadFile , uploadMiddleware } from "../controller/filleController.js";
import { deleteVoice, downloadVoice, getAllCompanyVoices, uploadVoice , voiceUploadMiddleware } from "../controller/voiceController.js";
const router = express.Router();

router.get("/user", getLogginUser)
router.get("/companyUsers" , getUsersByCompany)
router.get("/messages", getMessagesByRoom);
router.get("/rooms" , getRooms)


//room delete 
router.delete("/delete/room/:roomId" , handleDeleteRoom)

//file upload and download
router.post("/upload" , uploadMiddleware , uploadFile)
router.get("/download/:fileID"  , downloadFile)
router.delete("/delete/file/:fileID" , deleteFile  ) // delete one file 
router.get("/get/file/:roomId" , getFilesByRoom) 

//voice upload and download
router.post("/upload/voice", voiceUploadMiddleware , uploadVoice)
router.get("/download/voice/:voiceId" ,downloadVoice)
router.delete("/delete/voice/:voiceId" , deleteVoice ) // delete one voice file
router.get("/get/voice/:roomId" , getAllCompanyVoices ) // delete all voice file of that roomes
export default router ;