const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// 1. Connect to MongoDB (Replace with your own MongoDB Atlas connection string)
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/greenlight';
mongoose.connect(MONGO_URI)
  .then(() => console.log('🟢 Connected to MongoDB Database'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// 2. Define User Schema with all security constraints & ₹0 balances
const userSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  userCode: { type: String, required: true, unique: true },
  isApproved: { type: Boolean, default: false }, // Requires admin approval before login
  totalBalance: { type: Number, default: 0 },
  depositBalance: { type: Number, default: 0 },
  bonusBalance: { type: Number, default: 0 },
  winBalance: { type: Number, default: 0 },
  registrationIp: { type: String, required: true } // Tracks IP address for 1-account-per-IP rule
});

const User = mongoose.model('User', userSchema);

// JWT Secret Key
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_green_light_key_123';

// ==========================================
// ROUTE: REGISTER NEW ACCOUNT
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phoneNumber, password } = req.body;

    // Rule 1: Strict 10-digit phone verification
    const phoneRegex = /^\d{10}$/;
    if (!phoneRegex.test(phoneNumber)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Phone number must be a real, exact 10-digit number.' 
      });
    }

    // Rule 2: Check IP Address Restriction (1 account per IP address)
    const clientIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress;

    const existingIpUser = await User.findOne({ registrationIp: clientIp });
    if (existingIpUser) {
      return res.status(403).json({ 
        success: false, 
        message: 'Registration Blocked: Only one account can be registered from this IP address.' 
      });
    }

    // Rule 3: Check if phone number is already registered (Only 1 account per phone)
    const existingPhoneUser = await User.findOne({ phoneNumber });
    if (existingPhoneUser) {
      return res.status(400).json({ 
        success: false, 
        message: 'This phone number is already registered.' 
      });
    }

    // Rule 4: Auto-Generate Unique Backend ID (USR-XXXXXX)
    const randomNum = Math.floor(100000 + Math.random() * 900000);
    const userCode = `USR-${randomNum}`;

    // Rule 5: Hash password securely
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Rule 6: Save user with ₹0 balances and pending approval status
    const newUser = new User({
      phoneNumber,
      password: hashedPassword,
      userCode,
      isApproved: false,       // Must be approved by admin before login
      totalBalance: 0,
      depositBalance: 0,
      bonusBalance: 0,
      winBalance: 0,
      registrationIp: clientIp
    });

    await newUser.save();

    res.status(200).json({
      success: true,
      message: 'Account registered successfully. Pending admin approval.',
      userCode: userCode
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error during registration.' });
  }
});

// ==========================================
// ROUTE: LOGIN EXISTING USER
// ==========================================
app.post('/api/auth/login', async (req, res) => {
  try {
    const { phoneNumber, password } = req.body;

    // Find user by phone number
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid phone number or password.' });
    }

    // Check if account is approved by admin
    if (!user.isApproved) {
      return res.status(403).json({ success: false, message: 'Account is pending admin approval. Please wait.' });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Invalid phone number or password.' });
    }

    // Generate JWT Token valid for 7 days
    const token = jwt.sign({ userId: user._id, userCode: user.userCode }, JWT_SECRET, { expiresIn: '7d' });

    res.status(200).json({
      success: true,
      token,
      message: 'Login successful'
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error during login.' });
  }
});

// ==========================================
// ROUTE: FETCH USER PROFILE & BALANCES (Protected)
// ==========================================
app.get('/api/user/profile', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ message: 'No token provided' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const user = await User.findById(decoded.userId).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.status(200).json({
      phoneNumber: user.phoneNumber,
      userCode: user.userCode,
      totalBalance: user.totalBalance,
      depositBalance: user.depositBalance,
      bonusBalance: user.bonusBalance,
      winBalance: user.winBalance,
      isApproved: user.isApproved
    });

  } catch (err) {
    res.status(401).json({ message: 'Invalid or expired token' });
  }
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Backend server running on port ${PORT}`));