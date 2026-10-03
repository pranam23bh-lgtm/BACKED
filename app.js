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
  referredBy: { type: String, default: '' },
  isApproved: { type: Boolean, default: false },
  totalBalance: { type: Number, default: 0 },
  depositBalance: { type: Number, default: 0 },
  bonusBalance: { type: Number, default: 0 },
  winBalance: { type: Number, default: 0 },
  registrationIp: { type: String, required: true },
  activeBets: [{
    roundId: { type: String, required: true },
    color: { type: String, required: true },
    amount: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now }
  }]
});
const User = mongoose.model('User', userSchema);

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['deposit', 'withdraw'], required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  utr: { type: String, unique: true, sparse: true },
  method: { type: String },
  bankDetails: { type: String },
  createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

// ==========================================
// BET HISTORY SCHEMA (NEW)
// ==========================================
const betHistorySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  roundId: { type: String, required: true },
  color: { type: String, required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['Pending', 'Won', 'Lost'], default: 'Pending' },
  winningColor: { type: String, default: '' },
  payout: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const BetHistory = mongoose.model('BetHistory', betHistorySchema);

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: { type: String }
});
const Setting = mongoose.model('Setting', settingsSchema);

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_green_light_key_123';

// In-memory concurrency lock to prevent rapid multi-click race conditions[cite: 5]
if (!global.activeBettingUsers) {
  global.activeBettingUsers = new Set();
}

// ==========================================
// AUTH & USER ROUTES
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phoneNumber, password, referralCode } = req.body;
    const phoneRegex = /^\d{10}$/;
    if (!phoneRegex.test(phoneNumber)) {
      return res.status(400).json({ success: false, message: 'Phone number must be a real, exact 10-digit number.' });
    }

    const clientIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress;
    const existingPhoneUser = await User.findOne({ phoneNumber });
    if (existingPhoneUser) {
      return res.status(400).json({ success: false, message: 'This phone number is already registered.' });
    }

    let validReferrerCode = '';
    if (referralCode) {
      const referrerUser = await User.findOne({ userCode: referralCode.toUpperCase() });
      if (!referrerUser) {
        return res.status(400).json({ success: false, message: 'Invalid referral code entered.' });
      }
      validReferrerCode = referrerUser.userCode;
    }

    const autoSetting = await Setting.findOne({ key: 'auto_approve_registrations' });
    const isApproved = autoSetting ? (autoSetting.value === 'true') : false;

    const randomNum = Math.floor(100000 + Math.random() * 900000);
    const userCode = `USR-${randomNum}`;
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      phoneNumber,
      password: hashedPassword,
      userCode,
      referredBy: validReferrerCode,
      isApproved,
      totalBalance: 0,
      depositBalance: 0,
      bonusBalance: 0,
      winBalance: 0,
      registrationIp: clientIp
    });

    await newUser.save();
    res.status(200).json({ 
      success: true, 
      message: isApproved ? 'Account registered and approved successfully.' : 'Account registered successfully. Pending admin approval.', 
      userCode 
    });
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
    if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const user = await User.findById(decoded.userId).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    res.status(200).json({
      success: true,
      phoneNumber: user.phoneNumber,
      userCode: user.userCode,
      referredBy: user.referredBy,
      totalBalance: user.totalBalance,
      depositBalance: user.depositBalance,
      bonusBalance: user.bonusBalance,
      winBalance: user.winBalance,
      isApproved: user.isApproved
    });
  } catch (err) {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
});

// ==========================================
// SET REFERRAL CODE ROUTE
// ==========================================
app.post('/api/user/set-referral', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const { referralCode } = req.body;
    if (!referralCode) {
      return res.status(400).json({ success: false, message: 'Referral code is required.' });
    }

    const user = await User.findById(decoded.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (user.referredBy) {
      return res.status(400).json({ success: false, message: 'Referral code can only be set once.' });
    }

    if (user.userCode === referralCode.toUpperCase()) {
      return res.status(400).json({ success: false, message: 'You cannot use your own referral code.' });
    }

    const referrerUser = await User.findOne({ userCode: referralCode.toUpperCase() });
    if (!referrerUser) {
      return res.status(400).json({ success: false, message: 'Invalid referral code.' });
    }

    user.referredBy = referrerUser.userCode;
    await user.save();

    res.status(200).json({ success: true, message: 'Referral code applied successfully!' });
  } catch (err) {
    console.error("❌ Error setting referral code:", err);
    res.status(500).json({ success: false, message: 'Server error setting referral code.' });
  }
});

app.get('/api/user/transactions', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const transactions = await Transaction.find({ userId: decoded.userId }).sort({ createdAt: -1 });
    
    const sanitizedTransactions = transactions.map(tx => {
      const t = tx.toObject();
      if (t.type === 'deposit') {
        delete t.utr;
      }
      return t;
    });

    res.status(200).json({ success: true, transactions: sanitizedTransactions });
  } catch (err) {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
});

app.get('/api/user/history', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const transactions = await Transaction.find({ userId: decoded.userId }).sort({ createdAt: -1 });
    
    const sanitizedTransactions = transactions.map(tx => {
      const t = tx.toObject();
      if (t.type === 'deposit') {
        delete t.utr;
      }
      return t;
    });

    res.status(200).json({ success: true, transactions: sanitizedTransactions, history: sanitizedTransactions });
  } catch (err) {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
});

// ==========================================
// GET USER BET HISTORY ROUTE (NEW)
// ==========================================
app.get('/api/user/bet-history', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const history = await BetHistory.find({ userId: decoded.userId }).sort({ createdAt: -1 }).limit(50);
    res.status(200).json({ success: true, betHistory: history });
  } catch (err) {
    console.error("❌ Error fetching bet history:", err);
    res.status(500).json({ success: false, message: 'Server error fetching bet history' });
  }
});

// ==========================================
// WITHDRAWAL & DEPOSIT ROUTES
// ==========================================
app.post('/api/user/withdraw', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const { amount, bankDetails } = req.body;
    const withdrawAmount = Number(amount);
    if (!withdrawAmount || withdrawAmount <= 0 || !bankDetails) {
      return res.status(400).json({ success: false, message: 'Valid amount and destination details are required' });
    }

    const user = await User.findById(decoded.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const totalAvailable = Number(user.depositBalance || 0) + Number(user.bonusBalance || 0) + Number(user.winBalance || 0);

    if (totalAvailable < withdrawAmount || Number(user.totalBalance) < withdrawAmount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    let remainingToDeduct = withdrawAmount;

    if ((user.winBalance || 0) >= remainingToDeduct) {
      user.winBalance -= remainingToDeduct;
      remainingToDeduct = 0;
    } else {
      remainingToDeduct -= (user.winBalance || 0);
      user.winBalance = 0;
    }

    if (remainingToDeduct > 0) {
      if ((user.bonusBalance || 0) >= remainingToDeduct) {
        user.bonusBalance -= remainingToDeduct;
        remainingToDeduct = 0;
      } else {
        remainingToDeduct -= (user.bonusBalance || 0);
        user.bonusBalance = 0;
      }
    }

    if (remainingToDeduct > 0) {
      user.depositBalance -= remainingToDeduct;
    }

    user.totalBalance = Number(user.depositBalance || 0) + Number(user.bonusBalance || 0) + Number(user.winBalance || 0);
    await user.save();

    const newWithdrawal = new Transaction({
      userId: decoded.userId,
      type: 'withdraw',
      amount: withdrawAmount,
      bankDetails,
      status: 'Pending'
    });

    await newWithdrawal.save();
    res.status(200).json({ success: true, message: 'Withdrawal request submitted successfully' });
  } catch (err) {
    console.error("❌ Withdrawal Server Error:", err);
    res.status(500).json({ success: false, message: 'Server error submitting withdrawal' });
  }
});

// ==========================================
// SETTINGS & AUTO-APPROVE ROUTES
// ==========================================
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await Setting.find({});
    const settingsObj = {};
    settings.forEach(s => {
      settingsObj[s.key] = s.value;
    });

    res.status(200).json({
      success: true,
      customerServiceName: settingsObj.customer_service_name || '24/7 Live Support',
      telegramLink: settingsObj.telegram_link || 'https://t.me/your_telegram_username',
      telegramUsername: settingsObj.telegram_username || '',
      supportLogoUrl: settingsObj.support_logo_url || '',
      logoUrl: settingsObj.logo_url || ''
    });
  } catch (err) {
    console.error("❌ Error fetching settings:", err);
    res.status(500).json({ success: false, message: 'Error fetching settings' });
  }
});

app.post('/api/admin/settings/upi', async (req, res) => {
  try {
    const { upiId } = req.body;
    if (!upiId) {
      return res.status(400).json({ success: false, message: 'UPI ID/Text is required' });
    }

    await Setting.findOneAndUpdate(
      { key: 'upi_id' },
      { value: upiId },
      { upsert: true, new: true }
    );

    res.status(200).json({ success: true, message: 'UPI ID updated successfully' });
  } catch (err) {
    console.error("❌ Error updating UPI ID:", err);
    res.status(500).json({ success: false, message: 'Server error updating UPI ID' });
  }
});

app.post('/api/admin/settings/support', async (req, res) => {
  try {
    const { customerServiceName, telegramLink, telegramUsername, supportLogoUrl } = req.body;

    if (customerServiceName !== undefined) {
      await Setting.findOneAndUpdate({ key: 'customer_service_name' }, { value: customerServiceName }, { upsert: true, new: true });
    }
    if (telegramLink !== undefined) {
      await Setting.findOneAndUpdate({ key: 'telegram_link' }, { value: telegramLink }, { upsert: true, new: true });
    }
    if (telegramUsername !== undefined) {
      await Setting.findOneAndUpdate({ key: 'telegram_username' }, { value: telegramUsername }, { upsert: true, new: true });
    }
    if (supportLogoUrl !== undefined) {
      await Setting.findOneAndUpdate({ key: 'support_logo_url' }, { value: supportLogoUrl }, { upsert: true, new: true });
    }

    res.status(200).json({ success: true, message: 'Support settings updated successfully' });
  } catch (err) {
    console.error("❌ Error updating support settings:", err);
    res.status(500).json({ success: false, message: 'Server error updating support settings' });
  }
});

app.get('/api/settings/upi', async (req, res) => {
  try {
    const setting = await Setting.findOne({ key: 'upi_id' });
    res.status(200).json({ success: true, upiId: setting ? setting.value : 'merchant@ybl' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error fetching UPI ID' });
  }
});

app.get('/api/admin/settings/auto-approve', async (req, res) => {
  try {
    const setting = await Setting.findOne({ key: 'auto_approve_registrations' });
    const enabled = setting ? (setting.value === 'true') : false;
    res.status(200).json({ success: true, enabled });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error fetching setting' });
  }
});

app.post('/api/admin/settings/auto-approve', async (req, res) => {
  try {
    const { enabled } = req.body;
    await Setting.findOneAndUpdate(
      { key: 'auto_approve_registrations' },
      { value: enabled ? 'true' : 'false' },
      { upsert: true, new: true }
    );
    res.status(200).json({ success: true, enabled: !!enabled });
  } catch (err) {
    console.error("❌ Error updating auto-approve setting:", err);
    res.status(500).json({ success: false, message: 'Server error updating setting' });
  }
});

app.post('/api/user/deposit', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const { amount, utr, method } = req.body;
    if (!amount || !utr) {
      return res.status(400).json({ success: false, message: 'Amount and UTR are required' });
    }

    const existingUtr = await Transaction.findOne({ utr });
    if (existingUtr) {
      return res.status(400).json({ 
        success: false, 
        message: 'This UTR has already been submitted before. Please use a unique UTR.' 
      });
    }

    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const newDeposit = new Transaction({
      userId: user._id,
      type: 'deposit',
      amount: Number(amount),
      utr,
      method: method || 'PhonePe',
      status: 'Pending'
    });

    await newDeposit.save();
    res.status(200).json({ 
      success: true, 
      message: 'Deposit request submitted successfully. Awaiting admin approval.' 
    });
  } catch (err) {
    console.error("❌ Deposit Server Error:", err);
    res.status(500).json({ success: false, message: 'Server error submitting deposit' });
  }
});

app.post('/api/user/bet', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ success: false, message: 'Unauthorized' });

  let decoded;
  try {
    const token = authHeader.split(' ')[1];
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }

  // Prevent concurrent multi-click race conditions for the same user[cite: 5]
  if (global.activeBettingUsers.has(decoded.userId)) {
    return res.status(429).json({ success: false, message: 'Please wait, your previous bet is still processing.' });
  }

  global.activeBettingUsers.add(decoded.userId);

  try {
    const { amount, color, socketId, roundId } = req.body;
    const betAmount = Number(amount);

    if (!betAmount || betAmount <= 0 || !color || !roundId) {
      return res.status(400).json({ success: false, message: 'Valid amount, color, and roundId are required' });
    }

    const user = await User.findById(decoded.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const totalAvailable = Number(user.depositBalance || 0) + Number(user.bonusBalance || 0) + Number(user.winBalance || 0);
    
    // Strict validation against over-betting[cite: 5]
    if (totalAvailable < betAmount || Number(user.totalBalance) < betAmount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    // Deduct bet amount from buckets: Deposit -> Bonus -> Win[cite: 5]
    let remainingToDeduct = betAmount;

    if (user.depositBalance >= remainingToDeduct) {
      user.depositBalance -= remainingToDeduct;
      remainingToDeduct = 0;
    } else {
      remainingToDeduct -= user.depositBalance;
      user.depositBalance = 0;
    }

    if (remainingToDeduct > 0) {
      if (user.bonusBalance >= remainingToDeduct) {
        user.bonusBalance -= remainingToDeduct;
        remainingToDeduct = 0;
      } else {
        remainingToDeduct -= user.bonusBalance;
        user.bonusBalance = 0;
      }
    }

    if (remainingToDeduct > 0) {
      user.winBalance -= remainingToDeduct;
    }

    // Update authoritative total balance[cite: 5]
    user.totalBalance = Number(user.depositBalance || 0) + Number(user.bonusBalance || 0) + Number(user.winBalance || 0);

    user.activeBets.push({
      roundId: String(roundId),
      color: color.toUpperCase(),
      amount: betAmount
    });

    await user.save();

    // Save persistent bet history record
    const newBetRecord = new BetHistory({
      userId: user._id,
      roundId: String(roundId),
      color: color.toUpperCase(),
      amount: betAmount,
      status: 'Pending'
    });
    await newBetRecord.save();

    if (!global.colorPools) global.colorPools = { GREEN: 0, RED: 0, WHITE: 0 };
    if (!global.currentRoundBets) global.currentRoundBets = [];

    const normalizedColor = color.toUpperCase();
    if (global.colorPools[normalizedColor] !== undefined) {
      global.colorPools[normalizedColor] += betAmount;
    }

    let existingBet = global.currentRoundBets.find(
      b => b.userId.toString() === user._id.toString() && b.color === normalizedColor
    );

    if (existingBet) {
      existingBet.amount += betAmount;
    } else {
      global.currentRoundBets.unshift({
        userId: user._id,
        userCode: user.userCode,
        socketId: socketId || '',
        color: normalizedColor,
        amount: betAmount,
        time: new Date().toLocaleTimeString()
      });
    }

    if (global.io) {
      global.io.emit('live_bet_update', {
        colorPools: global.colorPools,
        currentRoundBets: global.currentRoundBets
      });
    }

    res.status(200).json({ 
      success: true, 
      message: 'Bet placed successfully', 
      newBalance: user.totalBalance 
    });
  } catch (err) {
    console.error("❌ Bet Server Error:", err);
    res.status(500).json({ success: false, message: 'Server error placing bet' });
  } finally {
    global.activeBettingUsers.delete(decoded.userId);
  }
});

async function settleRound(roundId, winningColor) {
  const stringRoundId = String(roundId);
  const users = await User.find({ 'activeBets.roundId': stringRoundId });

  for (let user of users) {
    const roundBets = user.activeBets.filter(b => b.roundId === stringRoundId);
    if (roundBets.length === 0) continue;

    let hasWon = false;
    let totalPayout = 0;

    for (let bet of roundBets) {
      const multiplier = (winningColor === 'WHITE') ? 5 : 2;
      const isWin = (bet.color === winningColor);
      const payoutAmount = isWin ? Number(bet.amount) * multiplier : 0;

      if (isWin) {
        hasWon = true;
        totalPayout += payoutAmount;
      }

      // Update BetHistory record status
      await BetHistory.findOneAndUpdate(
        { userId: user._id, roundId: stringRoundId, color: bet.color, status: 'Pending' },
        { 
          status: isWin ? 'Won' : 'Lost', 
          winningColor: winningColor, 
          payout: payoutAmount 
        }
      );
    }

    if (hasWon) {
      user.winBalance = Number(user.winBalance || 0) + totalPayout;
    }

    user.totalBalance = Number(user.depositBalance || 0) + Number(user.bonusBalance || 0) + Number(user.winBalance || 0);
    user.activeBets = user.activeBets.filter(b => b.roundId !== stringRoundId);

    await user.save();
  }
}

app.settleRound = settleRound;

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

    const user = await User.findById(tx.userId);
    if (user) {
      if (action === 'Approved' && tx.type === 'deposit') {
        user.depositBalance = Number(user.depositBalance || 0) + Number(tx.amount);
      } else if (action === 'Rejected' && tx.type === 'withdraw') {
        user.depositBalance = Number(user.depositBalance || 0) + Number(tx.amount);
      }

      user.totalBalance = Number(user.depositBalance || 0) + Number(user.bonusBalance || 0) + Number(user.winBalance || 0);
      await user.save();
    }

    res.status(200).json({ success: true, message: `Transaction ${action} successfully` });
  } catch (err) {
    console.error("❌ Transaction Action Error:", err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

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

app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ _id: -1 });
    res.status(200).json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error fetching users' });
  }
});

app.post('/api/admin/approve-user/:id', async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { isApproved: true }, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.status(200).json({ success: true, message: 'User approved successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error approving user' });
  }
});

app.delete('/api/admin/user/:id', async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.status(200).json({ success: true, message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error deleting user' });
  }
});

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
    console.error("❌ Error fetching pending deposits:", err);
    res.status(500).json({ success: false, message: 'Server error fetching deposits' });
  }
});

app.get('/api/admin/referrals', async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ _id: -1 });
    const referralData = [];

    for (const user of users) {
      let referrerPhone = 'Direct / None';
      if (user.referredBy) {
        const refUser = await User.findOne({ userCode: user.referredBy });
        if (refUser) {
          referrerPhone = refUser.phoneNumber;
        }
      }

      const invitedUsers = await User.find({ referredBy: user.userCode }).sort({ createdAt: -1 });

      let depositedCount = 0;
      let notDepositedCount = 0;
      const invitedDetails = [];

      for (const invitee of invitedUsers) {
        const approvedDeposit = await Transaction.findOne({ 
          userId: invitee._id, 
          type: 'deposit', 
          status: 'Approved' 
        });

        const hasDeposited = !!approvedDeposit;
        if (hasDeposited) {
          depositedCount++;
        } else {
          notDepositedCount++;
        }

        const subInvitesCount = await User.countDocuments({ referredBy: invitee.userCode });

        invitedDetails.push({
          userId: invitee._id,
          userCode: invitee.userCode,
          phoneNumber: invitee.phoneNumber,
          hasDeposited,
          registeredAt: invitee.createdAt || invitee._id.getTimestamp(),
          subInvitesCount
        });
      }

      referralData.push({
        userId: user._id,
        userCode: user.userCode,
        phoneNumber: user.phoneNumber,
        referredBy: user.referredBy || '',
        referrerPhone: referrerPhone,
        totalInvites: invitedUsers.length,
        depositedCount,
        notDepositedCount,
        invitedUsers: invitedDetails
      });
    }

    res.status(200).json({ success: true, referrals: referralData });
  } catch (err) {
    console.error("❌ Error fetching admin referrals:", err);
    res.status(500).json({ success: false, message: 'Server error fetching referral metrics' });
  }
});

app.get('/admin-settings.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-settings.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

module.exports = app;