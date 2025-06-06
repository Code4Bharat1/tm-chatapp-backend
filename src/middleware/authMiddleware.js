// // middleware/authMiddleware.js
// import jwt from 'jsonwebtoken';
// const protect = (req, res, next) => {
//     try {
//         const token = req.cookies.token; // Assuming it's stored as 'token'

//         if (!token) {
//             return res.status(401).json({ message: 'No token, authorization denied' });
//         }

//         const decoded = jwt.verify(token, process.env.JWT_SECRET);
//         req.user = decoded; // decoded should contain userId or other info
//         next();
//     } catch (error) {
//         return res.status(401).json({ message: 'Token is not valid', error });
//     }
// };

// const protectAdmin = (req, res, next) => {
//     try {
//         let admintoken = req.cookies.admintoken; // Assuming it's stored as 'token'
//     //     console.log('Received admintoken:', admintoken); // Log the token
//     // console.log('Cookies:', req.cookies); // Log all cookies
//     // console.log('Headers:', req.headers); // Log headers for Authorization


//     // If not found in cookies, check Authorization header
//         if (!admintoken && req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
//             admintoken = req.headers.authorization.split(' ')[1];
//         }

//         // console.log('Final token used:', admintoken);
//         // console.log('Cookies:', req.cookies);
//         // console.log('Headers:', req.headers);

//         if (!admintoken) {
//             return res.status(401).json({ message: 'No token, authorization denied' });
//         }

//         const decoded = jwt.verify(admintoken, process.env.JWT_SECRET);
//        // console.log('Decoded token:', decoded); // Log decoded token
//         req.user = decoded; // decoded should contain userId or other info
//         next();
//     } catch (error) {
//         console.error('Token verification error:', error.message);
//         return res.status(401).json({ message: 'admintoken is not valid', error });
//     }
// };

// const protectSuperAdmin = (req, res, next) => {
//     try {
//         const superAdminToken = req.cookies.superAdminToken; // Assuming it's stored as 'token'

//         if (!superAdminToken) {
//             return res.status(401).json({ message: 'No superAdminToken, authorization denied' });
//         }

//         const decoded = jwt.verify(superAdminToken, process.env.JWT_SECRET);
//         req.user = decoded; // decoded should contain userId or other info
//         next();
//     } catch (error) {
//         return res.status(401).json({ message: 'Token is not valid', error });
//     }
// };

// const protectUserOrAdmin = (req, res, next) => {
//     try {
//         let token = req.cookies.token || req.cookies.admintoken;

//         // Also allow token from Authorization header
//         if (!token && req.headers.authorization?.startsWith('Bearer')) {
//             token = req.headers.authorization.split(' ')[1];
//         }

//         if (!token) {
//             return res.status(401).json({ message: 'No token provided, authorization denied' });
//         }

//         const decoded = jwt.verify(token, process.env.JWT_SECRET);
//         req.user = decoded;
//         next();
//     } catch (error) {
//         return res.status(401).json({ message: 'Token is not valid', error });
//     }
// };

// const protectClient = (req, res, next) => {
//     try {
//         const token = req.cookies.clientToken;

//         if (!token) {
//             return res.status(401).json({ message: 'No token, authorization denied' });
//         }

//         const decoded = jwt.verify(token, process.env.JWT_SECRET);
//         req.user = decoded;
//         next();
//     } catch (error) {
//         return res.status(401).json({ message: 'Token is not valid', error: error.message });
//     }
// };

// export {
//     protect,
//     protectAdmin,
//     protectSuperAdmin,
//     protectUserOrAdmin,
//     protectClient
// };
// // This middleware checks for a JWT token in the request cookies, verifies it, and attaches the decoded user information to the request object.
// //  If the token is missing or invalid, it sends a 401 Unauthorized response.