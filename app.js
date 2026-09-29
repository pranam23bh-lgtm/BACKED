const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/greenlight';
mongoose.connect(MONGO_URI)
  .then(() => console.log('🟢 Connected to MongoDB Database'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// ==========================================
// SCHEMAS
// ==========================================
const userSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  userCode: { type: String, required: true, unique: true },
  isApproved: { type: Boolean, default: false },
  totalBalance: { type: Number, default: 0 },
  depositBalance: { type: Number, default: 0 },
  bonusBalance: { type: Number, default: 0 },
  winBalance: { type: Number, default: 0 },
  registrationIp: { type: String, required: true }
});
const User = mongoose.model('User', userSchema);

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

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: { type: String }
});
const Setting = mongoose.model('Setting', settingsSchema);

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_green_light_key_123';

// ==========================================
// AUTH & USER ROUTES
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phoneNumber, password } = req.body;
    const phoneRegex = /^\d{10}$/;
    if (!phoneRegex.test(phoneNumber)) {
      return res.status(400).json({ success: false, message: 'Phone number must be a real, exact 10-digit number.' });
    }

    const clientIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress;
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
    if (!user.isApproved) return res.status(403).json({ success: false, message: 'Account is pending admin approval.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ success: false, message: 'Invalid phone number or password.' });

    const token = jwt.sign({ userId: user._id, userCode: user.userCode }, JWT_SECRET, { expiresIn: '7d' });
    res.status(200).json({ success: true, token, message: 'Login successful' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error during login.' });
  }
});

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
// WITHDRAWAL & DEPOSIT ROUTES (WITH LOGGING)
// ==========================================
app.post('/api/user/withdraw', async (req, res) => {
  console.log("📥 [Withdrawal Endpoint Hit] Request Body:", req.body);
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      console.log("❌ Withdrawal Rejected: No authorization token provided");
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const { amount, bankDetails } = req.body;
    if (!amount || !bankDetails) {
      console.log("❌ Withdrawal Rejected: Missing amount or bank details");
      return res.status(400).json({ success: false, message: 'Amount and destination details are required' });
    }

    const user = await User.findById(decoded.userId);
    if (!user) {
      console.log("❌ Withdrawal Rejected: User not found in database");
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    console.log(`👤 User ${user.userCode} requested withdrawal of ₹${amount}. Current Balance: ₹${user.totalBalance}`);

    if (user.totalBalance < amount) {
      console.log(`❌ Withdrawal Rejected: Insufficient balance.`);
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

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
    console.log(`🟢 [SUCCESS] Withdrawal request saved to database for user ${user.userCode}`);
    res.status(200).json({ success: true, message: 'Withdrawal request submitted successfully' });
  } catch (err) {
    console.error("❌ Withdrawal Server Error:", err);
    res.status(500).json({ success: false, message: 'Server error submitting withdrawal' });
  }
});

// ==========================================
// ADMIN ROUTES
// ==========================================
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
      bankDetails: tx.bankDetails,
      createdAt: tx.createdAt
    }));

    res.status(200).json({ success: true, withdrawals: formatted });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/admin/transaction/action', async (req, res) => {
  try {
    const { transactionId, action } = req.body;
    const tx = await Transaction.findById(transactionId);
    if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found' });

    if (tx.status !== 'Pending') {
      return res.status(400).json({ success: false, message: `Transaction is already ${tx.status}` });
    }

    tx.status = action;
    await tx.save();

    if (action === 'Rejected' && tx.type === 'withdraw') {
      await User.findByIdAndUpdate(tx.userId, { $inc: { totalBalance: tx.amount } });
    }

    res.status(200).json({ success: true, message: `Transaction ${action} successfully` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

module.exports = app;
// ==========================================
// PLACE BET ROUTE
// ==========================================
app.post('/api/user/bet', async (req, res) => {
  console.log("📥 [Bet Endpoint Hit] Request Body:", req.body);
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const { amount, color } = req.body;
    if (!amount || !color) {
      return res.status(400).json({ success: false, message: 'Amount and color are required' });
    }

    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.totalBalance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    // Deduct bet amount from user's balance
    user.totalBalance -= Number(amount);
    await user.save();

    console.log(`🟢 [SUCCESS] Bet of ₹${amount} placed on ${color} by user ${user.userCode}`);
    res.status(200).json({ 
      success: true, 
      message: 'Bet placed successfully', 
      newBalance: user.totalBalance 
    });
  } catch (err) {
    console.error("❌ Bet Server Error:", err);
    res.status(500).json({ success: false, message: 'Server error placing bet' });
  }
});
// ==========================================
// MISSING ADMIN API ROUTES (FIXES 404 ERRORS)
// ==========================================

// 1. Admin Metrics Overview
app.get('/api/admin/metrics', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    
    const approvedDeposits = await Transaction.aggregate([
      { $match: { type: 'deposit', status: 'Approved' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const approvedWithdraws = await Transaction.aggregate([
      { $match: { type: 'withdraw', status: 'Approved' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    res.status(200).json({
      success: true,
      totalUsers,
      totalDeposits: approvedDeposits[0]?.total || 0,
      totalWithdraws: approvedWithdraws[0]?.total || 0
    });
  } catch (err) {
    console.error("❌ Metrics Error:", err);
    res.status(500).json({ success: false, message: 'Server error fetching metrics' });
  }
});

// 2. Get All Users
app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ _id: -1 });
    res.status(200).json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error fetching users' });
  }
});

// 3. Approve User Registration
app.post('/api/admin/approve-user/:id', async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { isApproved: true }, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.status(200).json({ success: true, message: 'User approved successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error approving user' });
  }
});

// 4. Delete User
app.delete('/api/admin/user/:id', async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.status(200).json({ success: true, message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error deleting user' });
  }
});

// 5. Pending Deposits Route
app.get('/api/admin/pending-deposits', async (req, res) => {
  try {
    const deposits = await Transaction.find({ type: 'deposit', status: 'Pending' })
      .populate('userId', 'phoneNumber userCode')
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, deposits });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error fetching deposits' });
  }
});