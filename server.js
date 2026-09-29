process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

const http = require('http');
const { Server } = require('socket.io');
const app = require('./app');

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

let currentRoundId = 100334;
let adminOverride = 'AUTO';
let onlineUsers = 0;
let timeRemaining = 30;
let currentOutcome = 'GREEN';
let gameHistory = ['GREEN', 'RED', 'WHITE', 'GREEN']; 

io.on('connection', (socket) => {
  onlineUsers++;
  socket.emit('round_result', { history: gameHistory });
  socket.emit('admin_override_update', { adminOverride });

  socket.on('admin_set_override', (mode) => {
    if (['AUTO', 'GREEN', 'WHITE', 'RED'].includes(mode)) {
      adminOverride = mode;
      io.emit('admin_override_update', { adminOverride });
    }
  });

  socket.on('disconnect', () => {
    onlineUsers--;
  });
});

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

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));