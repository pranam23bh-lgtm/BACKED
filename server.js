const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Serve all static assets inside the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Game State
let gameState = {
  roundId: 100001,
  timeLeft: 15,
  phase: 'BETTING',
  totalBets: { GREEN: 0, WHITE: 0, RED: 0 },
  history: ['GREEN', 'RED', 'GREEN', 'WHITE', 'RED'],
  adminOverride: 'AUTO'
};

let onlineCount = 0;
let metrics = {
  totalUsers: 142,
  totalDeposits: 54800,
  totalWithdraws: 19200
};

// Public Landing Page
app.get('/', (req, res) => {
  res.send(`
    <div style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px; background: #070a12; color: #fff;">
      <h1>🚀 Red Light Green Light Backend is Live & Online!</h1>
      <p><a href="/admin" style="color: #34d399; font-weight: bold;">Go to Admin Panel ➔</a></p>
    </div>
  `);
});

// Serve admin.html from inside the public folder
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Admin Metrics API
app.get('/api/admin/metrics', (req, res) => {
  res.json(metrics);
});

// Master Game Loop
setInterval(() => {
  gameState.timeLeft--;

  if (gameState.timeLeft <= 5 && gameState.phase === 'BETTING') {
    gameState.phase = 'CLOSED';
  }

  if (gameState.timeLeft <= 0) {
    let winner;
    if (gameState.adminOverride && gameState.adminOverride !== 'AUTO') {
      winner = gameState.adminOverride;
    } else {
      const colors = ['GREEN', 'RED', 'WHITE', 'GREEN', 'RED'];
      winner = colors[Math.floor(Math.random() * colors.length)];
    }
    
    gameState.history.push(winner);
    if (gameState.history.length > 30) gameState.history.shift();

    io.emit('round_result', {
      winner: winner,
      history: gameState.history
    });

    gameState.roundId++;
    gameState.timeLeft = 15;
    gameState.phase = 'BETTING';
    gameState.totalBets = { GREEN: 0, WHITE: 0, RED: 0 };
  }

  io.emit('master_tick', {
    roundId: gameState.roundId,
    timeLeft: gameState.timeLeft,
    phase: gameState.phase,
    totalBets: gameState.totalBets,
    onlineCount: onlineCount,
    adminOverride: gameState.adminOverride
  });
}, 1000);

// Simulated Bot Bets
setInterval(() => {
  if (gameState.phase === 'BETTING') {
    const botNames = ["Aarav Sharma", "Priya Patel", "Rahul Verma", "Ananya Singh", "Vikram Malhotra"];
    const colors = ['GREEN', 'RED', 'WHITE'];
    const randomName = botNames[Math.floor(Math.random() * botNames.length)];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    const randomAmount = [10, 50, 100, 500][Math.floor(Math.random() * 4)];

    gameState.totalBets[randomColor] += randomAmount;

    io.emit('bot_bet', {
      name: randomName,
      color: randomColor,
      amount: randomAmount
    });
  }
}, 2000);

io.on('connection', (socket) => {
  onlineCount++;
  console.log('User connected:', socket.id, '| Online:', onlineCount);

  socket.emit('init_sync', {
    onlineCount: onlineCount,
    gameState: gameState
  });

  socket.on('admin_set_override', (mode) => {
    if (['AUTO', 'GREEN', 'WHITE', 'RED'].includes(mode)) {
      gameState.adminOverride = mode;
      console.log('Admin changed override mode to:', mode);
      io.emit('master_tick', {
        roundId: gameState.roundId,
        timeLeft: gameState.timeLeft,
        phase: gameState.phase,
        totalBets: gameState.totalBets,
        onlineCount: onlineCount,
        adminOverride: gameState.adminOverride
      });
    }
  });

  socket.on('place_bet', (data) => {
    if (gameState.phase === 'BETTING') {
      if (gameState.totalBets[data.color] !== undefined) {
        gameState.totalBets[data.color] += data.amount;
      }
    }
  });

  socket.on('disconnect', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    console.log('User disconnected:', socket.id, '| Online:', onlineCount);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Master Game Server running on port ${PORT}`);
});