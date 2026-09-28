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

// ==========================================
// 2. DATABASE SCHEMAS
// ==========================================

// User Schema
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

// Transaction Schema (Handles both Deposits & Withdrawals)
const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['deposit', 'withdraw'], required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  utr: { type: String },
  method: { type: String },
  bankDetails: { type: String },
  createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

// App Settings Schema (For Merchant UPI ID, etc.)
const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: { type: String }
});
const Setting = mongoose.model('Setting', settingsSchema);

// JWT Secret Key
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_green_light_key_123';

// Game State Variables & Timer
let currentRoundId = 100334;
let adminOverride = 'AUTO';
let onlineUsers = 0;
let timeRemaining = 30;
let currentOutcome = 'GREEN';
let gameHistory = ['GREEN', 'RED', 'WHITE', 'GREEN']; 

// ==========================================
// SOCKET.IO REAL-TIME CONNECTION
// ==========================================
io.on('connection', (socket) => {
  onlineUsers++;
  console.log(`User connected: ${socket.id} | Online: ${onlineUsers}`);

  socket.emit('round_result', { history: gameHistory });
  socket.emit('admin_override_update', { adminOverride });

  socket.on('admin_set_override', (mode) => {
    if (['AUTO', 'GREEN', 'WHITE', 'RED'].includes(mode)) {
      adminOverride = mode;
      console.log(`⚡ Admin set override to: ${adminOverride}`);
      io.emit('admin_override_update', { adminOverride });
    }
  });

  socket.on('disconnect', () => {
    onlineUsers--;
    console.log(`User disconnected: ${socket.id} | Online: ${onlineUsers}`);
  });
});

// Dynamic Game Tick Loop
setInterval(() => {
  timeRemaining--;
  let phase = timeRemaining <= 15 ? 'CLOSED' : 'BETTING';

  if (timeRemaining <= 0) {
    if (adminOverride !== 'AUTO') {
      currentOutcome = adminOverride;
    } else {
      const colors = ['GREEN', 'RED', 'WHITE'];
      currentOutcome = colors[Math.floor(Math.random() * colors.length)];
    }

    gameHistory.unshift(currentOutcome);
    if (gameHistory.length > 10) gameHistory.pop();

    io.emit('round_result', {
      roundId: currentRoundId,
      outcome: currentOutcome,
      history: gameHistory
    });

    currentRoundId++;
    timeRemaining = 30;
    phase = 'BETTING';
  }

  io.emit('master_tick', {
    roundId: currentRoundId,
    timeLeft: timeRemaining,
    timer: timeRemaining,
    countdown: timeRemaining,
    phase: phase,
    status: phase,
    outcome: currentOutcome,
    color: currentOutcome,
    adminOverride: adminOverride,
    onlineUsers: onlineUsers
  });
}, 1000);

// ==========================================
// AUTHENTICATION ROUTES
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phoneNumber, password } = req.body;

    const phoneRegex = /^\d{10}$/;
    if (!phoneRegex.test(phoneNumber)) {
      return res.status(400).json({ success: false, message: 'Phone number must be a real, exact 10-digit number.' });
    }

    const clientIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress;

    const existingIpUser = await User.findOne({ registrationIp: clientIp });
    if (existingIpUser) {
      return res.status(403).json({ success: false, message: 'Registration Blocked: Only one account can be registered from this IP address.' });
    }

    const existingPhoneUser = await User.findOne({ phoneNumber });
    if (existingPhoneUser) {
      return res.status(400).json({ success: false, message: 'This phone number is already registered.' });
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
    res.status(200).json({ success: true, message: 'Account registered successfully. Pending admin approval.', userCode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error during registration.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phoneNumber, password } = req.body;

    const user = await User.findOne({ phoneNumber });
    if (!user) return res.status(400).json({ success: false, message: 'Invalid phone number or password.' });

    if (!user.isApproved) return res.status(403).json({ success: false, message: 'Account is pending admin approval. Please wait.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ success: false, message: 'Invalid phone number or password.' });

    const token = jwt.sign({ userId: user._id, userCode: user.userCode }, JWT_SECRET, { expiresIn: '7d' });
    res.status(200).json({ success: true, token, message: 'Login successful' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error during login.' });
  }
});

// ==========================================
// USER PROFILE & TRANSACTION SUBMISSION ROUTES
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

// User Deposit Request Submission
app.post('/api/user/deposit', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const { amount, utr, method } = req.body;
    if (!amount || !utr) return res.status(400).json({ success: false, message: 'Amount and UTR are required' });

    const newDeposit = new Transaction({
      userId: decoded.userId,
      type: 'deposit',
      amount: Number(amount),
      utr,
      method: method || 'UPI',
      status: 'Pending'
    });

    await newDeposit.save();
    res.status(200).json({ success: true, message: 'Deposit request submitted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error submitting deposit' });
  }
});

// User Withdrawal Request Submission
app.post('/api/user/withdraw', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const { amount, bankDetails } = req.body;
    if (!amount || !bankDetails) return res.status(400).json({ success: false, message: 'Amount and destination details are required' });

    const user = await User.findById(decoded.userId);
    if (!user || user.totalBalance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    // Deduct balance upon withdrawal request
    user.totalBalance -= Number(amount);
    await user.save();

    const newWithdrawal = new Transaction({
      userId: decoded.userId,
      type: 'withdraw',
      amount: Number(amount),
      bankDetails,
      status: 'Pending'
    });

    await newWithdrawal.save();
    res.status(200).json({ success: true, message: 'Withdrawal request submitted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error submitting withdrawal' });
  }
});

// ==========================================
// PUBLIC SETTINGS ROUTE
// ==========================================
app.get('/api/settings/upi', async (req, res) => {
  try {
    const setting = await Setting.findOne({ key: 'merchant_upi' });
    res.status(200).json({ success: true, upiId: setting ? setting.value : 'merchant@upi' });
  } catch (err) {
    res.status(500).json({ success: false, upiId: 'merchant@upi' });
  }
});

// ==========================================
// ADMIN CONTROL & MANAGEMENT ROUTES
// ==========================================

// Admin Login Route
app.post('/api/admin/login', (req, res) => {
  const { secret } = req.body;
  const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin123';
  if (secret === ADMIN_SECRET) {
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
    return res.status(200).json({ success: true, token });
  }
  res.status(401).json({ success: false, message: 'Invalid secret key' });
});

// Admin Metrics (Calculates real totals from approved transactions)
app.get('/api/admin/metrics', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    
    const approvedDeposits = await Transaction.find({ type: 'deposit', status: 'Approved' });
    const totalDeposits = approvedDeposits.reduce((acc, tx) => acc + tx.amount, 0);

    const approvedWithdraws = await Transaction.find({ type: 'withdraw', status: 'Approved' });
    const totalWithdraws = approvedWithdraws.reduce((acc, tx) => acc + tx.amount, 0);

    res.status(200).json({
      totalUsers,
      totalDeposits,
      totalWithdraws
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching metrics' });
  }
});

app.get('/api/admin/status', (req, res) => {
  res.status(200).json({
    success: true,
    adminOverride,
    currentRoundId,
    onlineUsers
  });
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

// Fetch All Pending Transactions Combined
app.get('/api/admin/pending-transactions', async (req, res) => {
  try {
    const pendingTransactions = await Transaction.find({ status: 'Pending' })
      .populate('userId', 'phoneNumber userCode')
      .sort({ createdAt: -1 });

    const deposits = [];
    const withdrawals = [];

    pendingTransactions.forEach(tx => {
      const formattedTx = {
        _id: tx._id,
        userCode: tx.userId ? tx.userId.userCode : 'N/A',
        phone: tx.userId ? tx.userId.phoneNumber : 'N/A',
        amount: tx.amount,
        utr: tx.utr,
        method: tx.method,
        bankDetails: tx.bankDetails,
        createdAt: tx.createdAt
      };

      if (tx.type === 'deposit') {
        deposits.push(formattedTx);
      } else {
        withdrawals.push(formattedTx);
      }
    });

    res.status(200).json({ success: true, deposits, withdrawals });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Fetch Pending Deposits Only (For `admin-deposits.html`)
app.get('/api/admin/pending-deposits', async (req, res) => {
  try {
    const deposits = await Transaction.find({ type: 'deposit', status: 'Pending' })
      .populate('userId', 'phoneNumber userCode')
      .sort({ createdAt: -1 });
    
    const formatted = deposits.map(tx => ({
      _id: tx._id,
      userCode: tx.userId ? tx.userId.userCode : 'N/A',
      phone: tx.userId ? tx.userId.phoneNumber : 'N/A',
      amount: tx.amount,
      utr: tx.utr,
      method: tx.method,
      createdAt: tx.createdAt
    }));

    res.status(200).json({ success: true, deposits: formatted });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Fetch Pending Withdrawals Only (For `admin-withdrawals.html`)
app.get('/api/admin/pending-withdrawals', async (req, res) => {
  try {
    const withdrawals = await Transaction.find({ type: 'withdraw', status: 'Pending' })
      .populate('userId', 'phoneNumber userCode')
      .sort({ createdAt: -1 });
    
    const formatted = withdrawals.map(tx => ({
      _id: tx._id,
      userCode: tx.userId ? tx.userId.userCode : 'N/A',
      phone: tx.userId ? tx.userId.phoneNumber : 'N/A',
      amount: tx.amount,
      utr: tx.utr,
      bankDetails: tx.bankDetails,
      createdAt: tx.createdAt
    }));

    res.status(200).json({ success: true, withdrawals: formatted });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Approve or Reject Transaction Action Route
app.post('/api/admin/transaction/action', async (req, res) => {
  try {
    const { transactionId, action } = req.body; // 'Approved' or 'Rejected'
    
    const tx = await Transaction.findById(transactionId);
    if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found' });

    // Prevent duplicate action processing
    if (tx.status !== 'Pending') {
      return res.status(400).json({ success: false, message: `Transaction is already ${tx.status}` });
    }

    tx.status = action;
    await tx.save();

    // If approved deposit, credit user balance
    if (action === 'Approved' && tx.type === 'deposit') {
      await User.findByIdAndUpdate(tx.userId, { 
        $inc: { totalBalance: tx.amount, depositBalance: tx.amount } 
      });
    }

    // If rejected withdrawal, refund the balance back to user
    if (action === 'Rejected' && tx.type === 'withdraw') {
      await User.findByIdAndUpdate(tx.userId, { 
        $inc: { totalBalance: tx.amount } 
      });
    }

    res.status(200).json({ success: true, message: `Transaction ${action} successfully` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Admin Route: Update/Upload Merchant UPI ID
app.post('/api/admin/settings/upi', async (req, res) => {
  try {
    const { upiId } = req.body;
    if (!upiId) return res.status(400).json({ success: false, message: 'UPI ID is required' });

    await Setting.findOneAndUpdate(
      { key: 'merchant_upi' },
      { value: upiId },
      { upsert: true, new: true }
    );

    res.status(200).json({ success: true, message: 'Merchant UPI updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error updating UPI' });
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