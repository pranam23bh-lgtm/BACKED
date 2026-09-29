process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const app = require('./app');

const User = mongoose.model('User');

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// --- MAKE IO & POOLS GLOBALLY ACCESSIBLE ---
global.io = io;
global.colorPools = { GREEN: 0, RED: 0, WHITE: 0 };
global.currentRoundBets = [];

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
  socket.emit('live_bet_update', {
    colorPools: global.colorPools,
    currentRoundBets: global.currentRoundBets
  });

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

// --- GAME LOOP TIMER & SETTLEMENT ---
setInterval(async () => {
  timeRemaining--;

  // Lock betting at 10 seconds remaining
  let phase = timeRemaining <= 10 ? 'CLOSED' : 'BETTING';

  if (timeRemaining <= 0) {
    phase = 'RESULT';

    // 1. Determine Winning Outcome
    if (adminOverride !== 'AUTO') {
      currentOutcome = adminOverride;
    } else {
      const colors = ['GREEN', 'RED', 'GREEN', 'RED', 'WHITE']; // Weighted slightly
      currentOutcome = colors[Math.floor(Math.random() * colors.length)];
    }

    // 2. Process Payouts & Wins for Active Bets
    const roundBets = [...global.currentRoundBets];
    global.currentRoundBets = [];
    global.colorPools = { GREEN: 0, RED: 0, WHITE: 0 };

    for (const bet of roundBets) {
      if (bet.color === currentOutcome) {
        const multiplier = currentOutcome === 'WHITE' ? 5 : 2;
        const winAmount = bet.amount * multiplier;

        try {
          const updatedUser = await User.findByIdAndUpdate(bet.userId, {
            $inc: { winBalance: winAmount, totalBalance: winAmount }
          }, { new: true });

          if (updatedUser && global.io && bet.socketId) {
            // Send winning notification popup to specific user socket
            global.io.to(bet.socketId).emit('round_win', {
              roundId: currentRoundId,
              winningColor: currentOutcome,
              winAmount,
              newBalance: updatedUser.totalBalance
            });
          }
        } catch (err) {
          console.error("❌ Error crediting win payout:", err);
        }
      }
    }

    gameHistory.unshift(currentOutcome);
    if (gameHistory.length > 10) gameHistory.pop();

    io.emit('round_result', {
      roundId: currentRoundId,
      outcome: currentOutcome,
      history: gameHistory,
      colorPools: global.colorPools
    });

    // Pause for 3 seconds before starting the next round countdown
    setTimeout(() => {
      currentRoundId++;
      timeRemaining = 30;
      phase = 'BETTING';

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
        onlineUsers: onlineUsers,
        colorPools: global.colorPools,
        currentRoundBets: global.currentRoundBets
      });
    }, 3000);
  }

  // Broadcast live timer tick
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
    onlineUsers: onlineUsers,
    colorPools: global.colorPools,
    currentRoundBets: global.currentRoundBets
  });
}, 1000);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));