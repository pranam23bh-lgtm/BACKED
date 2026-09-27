const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

// ==========================================
// CORS ALLOWLIST (Includes Netlify Frontend)
// ==========================================
const allowedOrigins = [
  'https://lucent-sherbet-5b6a1a.netlify.app',
  'http://localhost:3000',
  'http://127.0.0.1:5500'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all for seamless mobile/web sync
    }
  },
  credentials: true
}));

app.use(express.json());
// Serve static admin files from /public
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

// ==========================================
// SOCKET.IO WITH NETLIFY CORS
// ==========================================
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ==========================================
// MYSQL DATABASE CONNECTION POOL
// ==========================================
const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'red_green_game',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test Database Connection on startup
db.getConnection()
  .then((conn) => {
    console.log('✅ Connected to Remote MySQL Database successfully!');
    conn.release();
  })
  .catch((err) => {
    console.error('⚠️ Database Connection Warning:', err.message);
  });

// ==========================================
// MASTER GAME STATE
// ==========================================
let gameState = {
  roundId: 100001,
  phase: 'BETTING', // 'BETTING' (15s) | 'CLOSED' (2s) | 'PAUSE' (3s)
  timeLeft: 15,
  history: ['GREEN', 'RED', 'WHITE', 'GREEN', 'RED', 'GREEN', 'WHITE'],
  totalBets: { GREEN: 0, WHITE: 0, RED: 0 },
  adminOverride: 'AUTO',
  gatekeeperActive: true
};

const botNames = ['Aarav', 'Ananya', 'Vikram', 'Rahul', 'Priya', 'Suresh', 'Kavya'];

// ==========================================
// MASTER TICK CLOCK (20s SYNCHRONIZED LOOP)
// ==========================================
setInterval(async () => {
  gameState.timeLeft--;

  if (gameState.phase === 'BETTING' && gameState.timeLeft <= 0) {
    gameState.phase = 'CLOSED';
    gameState.timeLeft = 2;
    io.emit('phase_change', { phase: 'CLOSED', timeLeft: 2 });

  } else if (gameState.phase === 'CLOSED' && gameState.timeLeft <= 0) {
    const outcome = calculateOutcome();
    gameState.history.unshift(outcome);
    if (gameState.history.length > 20) gameState.history.pop();

    gameState.phase = 'PAUSE';
    gameState.timeLeft = 3;

    // Async Log to Database
    try {
      await db.query(
        `INSERT INTO game_rounds (round_id, outcome, total_green_bets, total_white_bets, total_red_bets) 
         VALUES (?, ?, ?, ?, ?)`,
        [gameState.roundId, outcome, gameState.totalBets.GREEN, gameState.totalBets.WHITE, gameState.totalBets.RED]
      );
    } catch (err) {
      // Gracefully log DB error without crashing master tick
      console.error('Round log DB error:', err.message);
    }

    io.emit('round_result', {
      roundId: gameState.roundId,
      outcome,
      history: gameState.history
    });

  } else if (gameState.phase === 'PAUSE' && gameState.timeLeft <= 0) {
    gameState.roundId++;
    gameState.phase = 'BETTING';
    gameState.timeLeft = 15;
    gameState.totalBets = { GREEN: 0, WHITE: 0, RED: 0 };

    io.emit('round_started', {
      roundId: gameState.roundId,
      timeLeft: 15,
      history: gameState.history
    });
  }

  // Push master state tick to all connected clients (Netlify users & Admin)
  io.emit('master_tick', {
    roundId: gameState.roundId,
    phase: gameState.phase,
    timeLeft: gameState.timeLeft,
    totalBets: gameState.totalBets,
    gatekeeperActive: gameState.gatekeeperActive,
    adminOverride: gameState.adminOverride,
    onlineCount: io.engine.clientsCount
  });

  // Simulate Bot activity
  if (gameState.phase === 'BETTING' && Math.random() > 0.4) {
    const color = ['GREEN', 'WHITE', 'RED'][Math.floor(Math.random() * 3)];
    const amt = [100, 200, 500, 1000][Math.floor(Math.random() * 4)];
    gameState.totalBets[color] += amt;
    io.emit('bot_bet', {
      name: botNames[Math.floor(Math.random() * botNames.length)],
      color,
      amount: amt,
      totalBets: gameState.totalBets
    });
  }

}, 1000);

function calculateOutcome() {
  if (gameState.adminOverride !== 'AUTO') return gameState.adminOverride;
  const rand = Math.random();
  if (rand < 0.425) return 'GREEN';
  if (rand < 0.850) return 'RED';
  return 'WHITE';
}

// ==========================================
// REST API ENDPOINTS
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ONLINE', connectedClients: io.engine.clientsCount });
});

app.get('/api/admin/metrics', async (req, res) => {
  try {
    const [[users]] = await db.query('SELECT COUNT(*) as totalUsers FROM users');
    const [[deposits]] = await db.query("SELECT SUM(amount) as totalDeposits FROM transactions WHERE type='DEPOSIT' AND status='APPROVED'");
    const [[withdraws]] = await db.query("SELECT SUM(amount) as totalWithdraws FROM transactions WHERE type='WITHDRAWAL' AND status='APPROVED'");
    const [pendingTx] = await db.query("SELECT t.*, u.user_code FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.status='PENDING'");

    res.json({
      totalUsers: users?.totalUsers || 0,
      totalDeposits: deposits?.totalDeposits || 0,
      totalWithdraws: withdraws?.totalWithdraws || 0,
      pendingTx: pendingTx || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/approve-tx', async (req, res) => {
  const { txId, action } = req.body;
  try {
    const [txs] = await db.query('SELECT * FROM transactions WHERE id = ?', [txId]);
    if (!txs.length) return res.status(404).json({ error: 'Transaction not found' });
    const tx = txs[0];

    await db.query('UPDATE transactions SET status = ? WHERE id = ?', [action, txId]);

    if (action === 'APPROVED' && tx.type === 'DEPOSIT') {
      await db.query('UPDATE users SET deposit_balance = deposit_balance + ? WHERE id = ?', [tx.amount, tx.user_id]);
    } else if (action === 'REJECTED' && tx.type === 'WITHDRAWAL') {
      await db.query('UPDATE users SET win_balance = win_balance + ? WHERE id = ?', [tx.amount, tx.user_id]);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// WEBSOCKET CONNECTION HANDLER
// ==========================================
io.on('connection', (socket) => {
  // Sync state immediately upon user load
  socket.emit('init_sync', { gameState, onlineCount: io.engine.clientsCount });

  socket.on('place_bet', (data) => {
    if (gameState.phase !== 'BETTING') return;
    const { color, amount } = data;
    if (['GREEN', 'WHITE', 'RED'].includes(color) && amount > 0) {
      gameState.totalBets[color] += amount;
      io.emit('bet_placed', { color, amount, totalBets: gameState.totalBets });
    }
  });

  // Admin Controls
  socket.on('admin_set_override', (color) => {
    gameState.adminOverride = color;
    io.emit('admin_state_updated', { adminOverride: gameState.adminOverride });
  });

  socket.on('admin_toggle_gatekeeper', () => {
    gameState.gatekeeperActive = !gameState.gatekeeperActive;
    io.emit('admin_state_updated', { gatekeeperActive: gameState.gatekeeperActive });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Master Server listening on port ${PORT}`);
});
