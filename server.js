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
let isTransitioning = false;

io.on('connection', (socket) => {
  onlineUsers++;
  
  socket.emit('round_result', { history: gameHistory });
  socket.emit('admin_override_update', { adminOverride });
  socket.emit('live_bet_update', {
    colorPools: global.colorPools,
    currentRoundBets: global.currentRoundBets
  });

  socket.on('admin_set_override', (mode) => {
    if (['AUTO', 'SMART', 'GREEN', 'WHITE', 'RED'].includes(mode)) {
      adminOverride = mode;
      io.emit('admin_override_update', { adminOverride });
      console.log(`🎮 [ADMIN OVERRIDE] Mode set to: ${adminOverride}`);
    }
  });

  socket.on('disconnect', () => {
    onlineUsers--;
  });
});

// --- GAME LOOP TIMER & SETTLEMENT ---
setInterval(async () => {
  if (isTransitioning) return;

  timeRemaining--;

  let phase = timeRemaining <= 10 ? 'CLOSED' : 'BETTING';

  if (timeRemaining <= 0) {
    isTransitioning = true;
    phase = 'RESULT';

    if (adminOverride === 'SMART') {
      const pools = global.colorPools || { GREEN: 0, RED: 0, WHITE: 0 };
      const totalCollection = (pools.GREEN || 0) + (pools.RED || 0) + (pools.WHITE || 0);

      if (totalCollection === 0) {
        const fallbackColors = ['GREEN', 'RED', 'WHITE'];
        currentOutcome = fallbackColors[Math.floor(Math.random() * fallbackColors.length)];
      } else {
        const profitGreen = totalCollection - ((pools.GREEN || 0) * 2);
        const profitRed = totalCollection - ((pools.RED || 0) * 2);
        const profitWhite = totalCollection - ((pools.WHITE || 0) * 5);

        const rankedOutcomes = [
          { color: 'GREEN', profit: profitGreen },
          { color: 'RED', profit: profitRed },
          { color: 'WHITE', profit: profitWhite }
        ].sort((a, b) => b.profit - a.profit);

        currentOutcome = rankedOutcomes[0].color;
      }
    } else if (['GREEN', 'WHITE', 'RED'].includes(adminOverride)) {
      currentOutcome = adminOverride;
    } else {
      const colors = ['GREEN', 'RED', 'GREEN', 'RED', 'WHITE'];
      currentOutcome = colors[Math.floor(Math.random() * colors.length)];
    }

    const roundBets = [...global.currentRoundBets];
    global.currentRoundBets = [];
    global.colorPools = { GREEN: 0, RED: 0, WHITE: 0 };

    // Execute robust centralized settlement from app.js with String roundId
    if (typeof app.settleRound === 'function') {
      await app.settleRound(String(currentRoundId), currentOutcome);
    }

    // Notify winning users via sockets
    for (const bet of roundBets) {
      if (bet.color === currentOutcome) {
        const multiplier = currentOutcome === 'WHITE' ? 5 : 2;
        const winAmount = Number(bet.amount) * multiplier;

        try {
          const userDoc = await User.findById(bet.userId);
          if (userDoc && global.io && bet.socketId) {
            global.io.to(bet.socketId).emit('round_win', {
              roundId: currentRoundId,
              winningColor: currentOutcome,
              winAmount,
              newBalance: userDoc.totalBalance
            });
          }
        } catch (err) {
          console.error("❌ Error notifying win payout:", err);
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

    setTimeout(() => {
      currentRoundId++;
      timeRemaining = 30;
      isTransitioning = false;
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

    return;
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
    onlineUsers: onlineUsers,
    colorPools: global.colorPools,
    currentRoundBets: global.currentRoundBets
  });
}, 1000);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));