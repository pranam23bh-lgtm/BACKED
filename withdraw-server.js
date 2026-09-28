const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// MongoDB & Secrets (Must match your main server configuration)
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/greenlight';
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_green_light_key_123';

mongoose.connect(MONGO_URI)
  .then(() => console.log('🟢 Dedicated Withdrawal Server connected to MongoDB'))
  .catch(err => console.error('❌ Withdrawal Server MongoDB Error:', err));

// Schemas
const userSchema = new mongoose.Schema({
  phoneNumber: String,
  totalBalance: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, default: 'withdraw' },
  amount: { type: Number, required: true },
  status: { type: String, default: 'Pending' },
  bankDetails: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

// ==========================================
// DEDICATED WITHDRAWAL SUBMISSION ROUTE
// ==========================================
app.post('/api/user/withdraw', async (req, res) => {
  console.log("📥 [Withdrawal Server] Received withdrawal request:", req.body);
  
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      console.log("❌ Rejected: No authorization header provided");
      return res.status(401).json({ success: false, message: 'Unauthorized: No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const { amount, bankDetails } = req.body;
    if (!amount || !bankDetails) {
      return res.status(400).json({ success: false, message: 'Amount and destination details are required' });
    }

    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.totalBalance < amount) {
      console.log(`❌ Rejected: Insufficient balance for user ${user.phoneNumber}. Balance: ${user.totalBalance}, Requested: ${amount}`);
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    // Deduct balance immediately
    user.totalBalance -= Number(amount);
    await user.save();

    // Save transaction to MongoDB
    const newWithdrawal = new Transaction({
      userId: decoded.userId,
      type: 'withdraw',
      amount: Number(amount),
      bankDetails,
      status: 'Pending'
    });

    await newWithdrawal.save();
    console.log(`🟢 [Withdrawal Server] Successfully saved withdrawal of ₹${amount} for user ID: ${decoded.userId}`);
    
    res.status(200).json({ success: true, message: 'Withdrawal request submitted successfully' });
  } catch (err) {
    console.error("❌ [Withdrawal Server] Error processing withdrawal:", err);
    res.status(500).json({ success: false, message: 'Server error submitting withdrawal' });
  }
});

// Health check route
app.get('/', (req, res) => {
  res.send('Withdrawal Microservice is running successfully!');
});

// Run on a separate port (e.g., 5002) or process.env.PORT
const PORT = process.env.WITHDRAW_PORT || 5002;
app.listen(PORT, () => console.log(`🚀 Dedicated Withdrawal Server running on port ${PORT}`));