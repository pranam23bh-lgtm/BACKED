process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.json());
app.use(cors());

// Serve static frontend files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// 1. Connect to MongoDB Atlas
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/greenlight';
mongoose.connect(MONGO_URI)
  .then(() => console.log('🟢 Connected to MongoDB Database'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// 2. Define User Schema with security constraints & ₹0 balances
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

// Game State Variables & Timer (Matching Frontend Expectations)
let currentRoundId = 100334;
let adminOverride = 'AUTO';
let onlineUsers = 0;
let timeRemaining = 30;
let currentOutcome = 'GREEN';
let gameHistory = ['GREEN', 'RED', 'WHITE', 'GREEN']; // Initial dummy history

// Socket.io Real-Time Connection
io.on('connection', (socket) => {
  onlineUsers++;
  console.log(`User connected: ${socket.id} | Online: ${onlineUsers}`);

  // Send current history immediately upon connection so frontend history renders
  socket.emit('round_result', { history: gameHistory });

  socket.on('admin_set_override', (mode) => {
    if (['AUTO', 'GREEN', 'WHITE', 'RED'].includes(mode)) {
      adminOverride = mode;
      console.log(`⚡ Admin set override to: ${adminOverride}`);
    }
  });

  socket.on('disconnect', () => {
    onlineUsers--;
    console.log(`User disconnected: ${socket.id} | Online: ${onlineUsers}`);
  });
});

// Dynamic Game Tick Loop (Emits timeLeft, phase, and round_result events)
setInterval(() => {
  timeRemaining--;

  let phase = timeRemaining <= 15 ? 'CLOSED' : 'BETTING'; // Matches frontend (0-15s / closed)

  if (timeRemaining <= 0) {
    if (adminOverride !== 'AUTO') {
      currentOutcome = adminOverride;
    } else {
      const colors = ['GREEN', 'RED', 'WHITE'];
      currentOutcome = colors[Math.floor(Math.random() * colors.length)];
    }

    // Add to history array for frontend history-container
    gameHistory.unshift(currentOutcome);
    if (gameHistory.length > 10) gameHistory.pop();

    // Broadcast round result so frontend updates history list
    io.emit('round_result', {
      roundId: currentRoundId,
      outcome: currentOutcome,
      history: gameHistory
    });

    currentRoundId++;
    timeRemaining = 30;
    phase = 'BETTING';
  }

  // Emitting exact property names your frontend looks for (timeLeft, phase)
  io.emit('master_tick', {
    roundId: currentRoundId,
    timeLeft: timeRemaining,
    timer: timeRemaining,
    countdown: timeRemaining,
    phase: phase,
    status: phase,
    outcome: currentOutcome,
    color: currentOutcome,
    onlineUsers: onlineUsers
  });
}, 1000);

// ==========================================
// ROUTE: REGISTER NEW ACCOUNT
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phoneNumber, password } = req.body;

    const phoneRegex = /^\d{10}$/;
    if (!phoneRegex.test(phoneNumber)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Phone number must be a real, exact 10-digit number.' 
      });
    }

    const clientIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress;

    const existingIpUser = await User.findOne({ registrationIp: clientIp });
    if (existingIpUser) {
      return res.status(403).json({ 
        success: false, 
        message: 'Registration Blocked: Only one account can be registered from this IP address.' 
      });
    }

    const existingPhoneUser = await User.findOne({ phoneNumber });
    if (existingPhoneUser) {
      return res.status(400).json({ 
        success: false, 
        message: 'This phone number is already registered.' 
      });
    }

    const randomNum = Math.floor(100000 + Math.random() * 900000);
    const userCode = `USR-${randomNum}`;

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      phoneNumber,
      password: hashedPassword,
      userCode,
      isApproved: false,
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

    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid phone number or password.' });
    }

    if (!user.isApproved) {
      return res.status(403).json({ success: false, message: 'Account is pending admin approval. Please wait.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Invalid phone number or password.' });
    }

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

// ==========================================
// ADMIN ROUTES
// ==========================================
app.get('/api/admin/metrics', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    res.status(200).json({
      totalUsers,
      totalDeposits: 0,
      totalWithdraws: 0
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching metrics' });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ _id: -1 });
    res.status(200).json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching users' });
  }
});

app.post('/api/admin/approve-user/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await User.findByIdAndUpdate(userId, { isApproved: true }, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    
    res.status(200).json({ success: true, message: `User ${user.userCode} approved!` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error approving user' });
  }
});

app.delete('/api/admin/user/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    await User.findByIdAndDelete(userId);
    res.status(200).json({ success: true, message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error deleting user' });
  }
});

// ==========================================
// ROOT ROUTE: SERVE ADMIN PANEL
// ==========================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Start Server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Backend server running on port ${PORT}`));