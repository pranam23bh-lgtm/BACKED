const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// FIX: Add a landing route so visiting the Render URL doesn't show "Cannot GET /"
app.get('/', (req, res) => {
  res.send(`
    <div style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px; background: #070a12; color: #fff;">
      <h1>🚀 Red Light Green Light Backend is Live & Online!</h1>
      <p>Socket.io game server is actively running and ready for frontend connections.</p>
    </div>
  `);
});

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
  phase: 'BETTING', // 'BETTING' or 'CLOSED'
  totalBets: { GREEN: 0, WHITE: 0, RED: 0 },
  history: ['GREEN', 'RED', 'GREEN', 'WHITE', 'RED']
};

let onlineCount = 1;

// Master Game Loop (Ticks every 1 second)
setInterval(() => {
  gameState.timeLeft--;

  // Switch to closed phase during the last 5 seconds
  if (gameState.timeLeft <= 5 && gameState.phase === 'BETTING') {
    gameState.phase = 'CLOSED';
  }

  // When round finishes
  if (gameState.timeLeft <= 0) {
    const colors = ['GREEN', 'RED', 'WHITE', 'GREEN', 'RED'];
    const winner = colors[Math.floor(Math.random() * colors.length)];
    
    gameState.history.push(winner);
    if (gameState.history.length > 30) gameState.history.shift();

    io.emit('round_result', {
      winner: winner,
      history: gameState.history
    });

    // Reset for next round
    gameState.roundId++;
    gameState.timeLeft = 15;
    gameState.phase = 'BETTING';
    gameState.totalBets = { GREEN: 0, WHITE: 0, RED: 0 };
  }

  // Broadcast tick to all connected players
  io.emit('master_tick', {
    roundId: gameState.roundId,
    timeLeft: gameState.timeLeft,
    phase: gameState.phase,
    totalBets: gameState.totalBets,
    onlineCount: onlineCount
  });
}, 1000);

// Simulated Player Bot Bets
setInterval(() => {
  if (gameState.phase === 'BETTING') {
    const botNames = ["Aarav Sharma", "Priya Patel", "Rahul Verma", "Ananya Singh", "Vikram Malhotra", "Neha Gupta", "Amit Kumar"];
    const colors = ['GREEN', 'RED', 'WHITE'];
    const randomName = botNames[Math.floor(Math.random() * botNames.length)];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    const randomAmount = [10, 50, 100, 500, 1000][Math.floor(Math.random() * 5)];

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

  // Send current game state upon connection
  socket.emit('init_sync', {
    onlineCount: onlineCount,
    gameState: gameState
  });

  socket.on('place_bet', (data) => {
    if (gameState.phase === 'BETTING') {
      if (gameState.totalBets[data.color] !== undefined) {
        gameState.totalBets[data.color] += data.amount;
      }
    }
  });

  socket.on('disconnect', () => {
    onlineCount = Math.max(1, onlineCount - 1);
    console.log('User disconnected:', socket.id, '| Online:', onlineCount);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Master Game Server running on port ${PORT}`);
});