import express from "express"
import { checkGroupChatAuth } from "../middleware/auth.middleware.js"
import { getLogginUser, getMessagesByRoom, getUsersByCompany } from "../controller/message.controller.js";
const router = express.Router();

router.get("/user", getLogginUser)
router.get("/companyUsers" , getUsersByCompany)
router.get("/messages", getMessagesByRoom);
// router.delete("/delete")
// router.put("/edit")

export default router ;