const express = require('express');
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const mysql = require('mysql');
const crypto = require('crypto');
const ChatManager = require('./ChatManager.js');
const chatManager = new ChatManager();

const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'idkcasino'
});

connection.connect();

connection.query(`
  CREATE TABLE IF NOT EXISTS bets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    color VARCHAR(10) NOT NULL,
    roll_id INT,
    won BOOLEAN,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

connection.query(`
  CREATE TABLE IF NOT EXISTS users (
    id BIGINT PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    avatar VARCHAR(255),
    balance DECIMAL(10,2) DEFAULT 0.00,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  connection.query('SELECT * FROM users WHERE id = ?', [id], (error, results) => {
    done(error, results[0]);
  });
});

passport.use(new SteamStrategy({
  returnURL: 'http://localhost:3000/auth/steam/return',
  realm: 'http://localhost:3000/',
  apiKey: '' //add your steam api key here
},
function(identifier, profile, done) {
  const steamId = profile.id;
  const username = profile.displayName;
  const avatar = profile._json.avatarfull;

  connection.query(
    'INSERT INTO users (id, username, avatar, balance) VALUES (?, ?, ?, "50000.00") ON DUPLICATE KEY UPDATE username = ?, avatar = ?',
    [steamId, username, avatar, username, avatar],
    (error) => {
      if (error) return done(error);
      return done(null, { id: steamId, username, avatar });
    }
  );
}
));

const sessionMiddleware = session({
  secret: 'your_session_secret',
  resave: false,
  saveUninitialized: false
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

io.engine.use(sessionMiddleware);

app.get('/auth/steam', passport.authenticate('steam'));

app.get('/auth/steam/return',
  passport.authenticate('steam', { failureRedirect: '/' }),
  (req, res) => {
    res.redirect('/');
  }
);

app.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/');
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/user', (req, res) => {
  res.json(req.user || null);
});

connection.query(`
  CREATE TABLE IF NOT EXISTS rolls (
    id INT AUTO_INCREMENT PRIMARY KEY,
    color VARCHAR(10) NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    serverSeed VARCHAR(64) NOT NULL,
    clientSeed VARCHAR(64) NOT NULL,
    nonce BIGINT NOT NULL,
    hash VARCHAR(64) NOT NULL
  )
`);

const PHASES = {
  COOLDOWN: 'cooldown',
  FLASHING: 'flashing',
  RESULT: 'result'
};

const COLORS = {
  RED: 'red',
  BLACK: 'black',
  GREEN: 'green'
};

class GameState {
  constructor() {
    this.currentPhase = PHASES.COOLDOWN;
    this.timeRemaining = 15;
    this.currentColor = null;
    this.flashCount = 0;
    this.serverSeed = crypto.randomBytes(32).toString('hex');
    this.clientSeed = crypto.randomBytes(32).toString('hex');
    this.nonce = Date.now().toString();
  }

  generateHash() {
    const data = this.serverSeed + this.clientSeed + this.nonce;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  getColorFromHash(hash) {
    const decimal = parseInt(hash.slice(0, 8), 16);
    const percentage = (decimal / 0xffffffff) * 100;
    
    if (percentage < 48) return COLORS.RED;
    if (percentage < 96) return COLORS.BLACK;
    return COLORS.GREEN;
  }
}

const gameState = new GameState();
let currentRoundBets = [];

function runGameLoop() {
  const cooldownTimer = setInterval(() => {
    if (gameState.timeRemaining > 0) {
      gameState.timeRemaining--;
      io.emit('updateState', gameState);
    } else {
      clearInterval(cooldownTimer);
      startFlashing();
    }
  }, 1000);
}

function startFlashing() {
  gameState.currentPhase = PHASES.FLASHING;
  const colors = [COLORS.RED, COLORS.BLACK, COLORS.GREEN];
  let flashIndex = 0;
  
  const flashTimer = setInterval(() => {
    if (gameState.flashCount < 5) {
      gameState.currentColor = colors[flashIndex % colors.length];
      flashIndex++;
      gameState.flashCount++;
      io.emit('updateState', gameState);
    } else {
      clearInterval(flashTimer);
      showResult();
    }
  }, 600);
}

async function fetchUserBalance(userId) {
    const idsToCheck = [userIdBigInt];

  // Add nearby IDs to check
  for (let i = 1; i <= 2; i++) {
    idsToCheck.push(userIdBigInt + BigInt(i)); // Positive
    idsToCheck.push(userIdBigInt - BigInt(i)); // Negative
  }

  for (const id of idsToCheck) {
    const [results] = await new Promise((resolve, reject) => {
      connection.query(
        'SELECT balance FROM users WHERE id = ?',
        [id],
        (error, results) => {
          if (error) {
            console.error('Error fetching current balance:', error);
            reject(error);
          } else {
            resolve([results]);
          }
        }
      );
    });

    if (results && results.length > 0) {
      console.log('Current balance fetched:', results[0].balance);
      return results[0].balance;
    }
  }

  console.error(`No balance found for user ${userId} or nearby IDs`);
  return null; // Return null if no balance was found
}

function showResult() {
  gameState.currentPhase = PHASES.RESULT;
  const hash = gameState.generateHash();
  gameState.currentColor = gameState.getColorFromHash(hash);
  
  console.log('Starting showResult with color:', gameState.currentColor);

  connection.beginTransaction(async (err) => {
    if (err) {
      console.error('Transaction begin error:', err);
      return;
    }

    try {
      console.log('Transaction started successfully');
      
      const [rollResult] = await new Promise((resolve, reject) => {
        connection.query(
          'INSERT INTO rolls (color, serverSeed, clientSeed, nonce, hash) VALUES (?, ?, ?, ?, ?)',
          [gameState.currentColor, gameState.serverSeed, gameState.clientSeed, gameState.nonce, hash],
          (error, result) => {
            if (error) {
              console.error('Roll insertion error:', error);
              reject(error);
            } else {
              console.log('Roll inserted successfully:', result.insertId);
              resolve([result]);
            }
          }
        );
      });

      const rollId = rollResult.insertId;

      // Modified query to handle BIGINT user IDs properly
      const [bets] = await new Promise((resolve, reject) => {
        connection.query(
          'SELECT b.*, u.username, u.balance, CAST(b.user_id AS CHAR) as user_id_string FROM bets b JOIN users u ON b.user_id = u.id WHERE b.roll_id IS NULL',
          (error, results) => {
            if (error) {
              console.error('Error fetching pending bets:', error);
              reject(error);
            } else {
              const processedResults = results.map(bet => ({
                ...bet,
                user_id: bet.user_id_string // Use the string version of the ID
              }));
              console.log('Found pending bets:', processedResults.length);
              resolve([processedResults]);
            }
          }
        );
      });

      for (const bet of bets) {
        // Log the exact user ID for debugging
        console.log('Processing bet with exact user ID:', bet.user_id);
        
        const won = bet.color === gameState.currentColor;
        const multiplier = bet.color === 'green' ? 14 : 2;
        const payout = won ? Number(bet.amount) * multiplier : 0;

        console.log('Processing bet:', {
          betId: bet.id,
          userId: bet.user_id,
          betColor: bet.color,
          amount: bet.amount,
          won,
          payout
        });

        await new Promise((resolve, reject) => {
          connection.query(
            'UPDATE bets SET roll_id = ?, won = ? WHERE id = ?',
            [rollId, won, bet.id],
            (error) => {
              if (error) {
                console.error('Error updating bet status:', error);
                reject(error);
              } else {
                console.log('Bet status updated successfully');
                resolve();
              }
            }
          );
        });

        if (won) {
          console.log('Processing winning bet for user:', bet.user_id, 'Payout:', payout);
          
          const [currentBalance] = await new Promise((resolve, reject) => {
            connection.query(
              'SELECT balance FROM users WHERE id = ? FOR UPDATE',
              [bet.user_id],
              (error, results) => {
                if (error) {
                  console.error('Error fetching current balance:', error);
                  reject(error);
                } else {
                  console.log('Current balance fetched:', results[0]?.balance);
                  resolve([results]);
                }
              }
            );
          });

          if (!currentBalance || currentBalance.length === 0) {
            console.error(`No balance found for user ${bet.user_id}, skipping payout`);
            continue;
          }

          const updateResult = await new Promise((resolve, reject) => {
            connection.query(
              'UPDATE users SET balance = balance + ? WHERE id = ? AND balance IS NOT NULL',
              [payout, bet.user_id],
              (error, result) => {
                if (error) {
                  console.error('Error updating balance:', error);
                  reject(error);
                } else {
                  console.log('Balance update result:', {
                    affectedRows: result.affectedRows,
                    changedRows: result.changedRows,
                    payout,
                    userId: bet.user_id
                  });
                  resolve(result);
                }
              }
            );
          });

          if (updateResult.affectedRows === 0) {
            console.error(`Failed to update balance for user ${bet.user_id}`);
            continue;
          }

          const [verifyBalance] = await new Promise((resolve, reject) => {
            connection.query(
              'SELECT username, balance FROM users WHERE id = ?',
              [bet.user_id],
              (error, results) => {
                if (error) {
                  console.error('Error verifying updated balance:', error);
                  reject(error);
                } else {
                  console.log('Verified new balance:', results[0]?.balance);
                  resolve([results]);
                }
              }
            );
          });

          if (verifyBalance && verifyBalance.length > 0) {
            const balanceChange = verifyBalance[0].balance - currentBalance[0].balance;
            console.log('Balance change verification:', {
              expected: payout,
              actual: balanceChange,
              finalBalance: verifyBalance[0].balance
            });

            io.emit('betResult', {
              userId: bet.user_id,
              won: true,
              amount: payout - Number(bet.amount),
              color: gameState.currentColor,
              username: verifyBalance[0].username
            });

            io.emit('balanceUpdate', {
              userId: bet.user_id,
              balance: verifyBalance[0].balance
            });
          } else {
            console.error('Failed to verify balance update for user:', bet.user_id);
          }
        }
      }

      const [historyResults] = await new Promise((resolve, reject) => {
        connection.query(
          'SELECT color FROM rolls ORDER BY timestamp DESC LIMIT 20',
          (error, results) => {
            if (error) {
              console.error('Error fetching history:', error);
              reject(error);
            } else {
              console.log('History fetched successfully');
              resolve([results]);
            }
          }
        );
      });

      currentRoundBets = []; // Clear bets for next round
      io.emit('currentRoundBets', currentRoundBets); // Update clients

      connection.commit((err) => {
        if (err) {
          console.error('Commit error:', err);
          return connection.rollback(() => {
            console.error('Transaction rolled back');
          });
        }
        console.log('Transaction committed successfully');
        io.emit('updateState', { ...gameState, history: historyResults });
      });

    } catch (error) {
      console.error('Transaction error:', error);
      return connection.rollback(() => {
        console.error('Transaction rolled back due to error:', error);
      });
    }
  });

  setTimeout(() => {
    resetGame();
  }, 3000);
}

function resetGame() {
  gameState.currentPhase = PHASES.COOLDOWN;
  gameState.timeRemaining = 15;
  gameState.currentColor = null;
  gameState.flashCount = 0;
  gameState.serverSeed = crypto.randomBytes(32).toString('hex');
  gameState.clientSeed = crypto.randomBytes(32).toString('hex');
  gameState.nonce = Date.now().toString();
  io.emit('updateState', gameState);
  runGameLoop();
}

app.get('/verify/:hash', (req, res) => {
  connection.query(
    'SELECT serverSeed, clientSeed, nonce, color FROM rolls WHERE hash = ?',
    [req.params.hash],
    (error, results) => {
      if (error || results.length === 0) {
        res.status(404).json({ error: 'Roll not found' });
        return;
      }
      
      const roll = results[0];
      const verificationHash = crypto
        .createHash('sha256')
        .update(roll.serverSeed + roll.clientSeed + roll.nonce)
        .digest('hex');
        
      res.json({
        verified: verificationHash === req.params.hash,
        roll: roll
      });
    }
  );
});

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);
  
  wrap(sessionMiddleware)(socket, () => {
    socket.emit('chatMessage', chatManager.getMessages());
    
    socket.on('chatMessage', (message) => {
      const messages = chatManager.addMessage(message);
      io.emit('chatMessage', messages);
    });


    socket.on('placeBet', async (data) => {
      if (!socket.request.session?.passport?.user) {
        return socket.emit('betResponse', { error: 'Please login to place bets' });
      }
    
      const userId = socket.request.session.passport.user;
      const { amount, color } = data;
      
      if (gameState.currentPhase !== PHASES.COOLDOWN) {
        return socket.emit('betResponse', { error: 'Betting is currently closed' });
      }
    
      if (!amount || amount <= 0) {
        return socket.emit('betResponse', { error: 'Invalid bet amount' });
      }
    
      try {
        const [userResults] = await promiseQuery(
          'SELECT balance, username, avatar FROM users WHERE id = ? FOR UPDATE',
          [userId]
        );
    
        if (!userResults || userResults.length === 0) {
          return socket.emit('betResponse', { error: 'User not found' });
        }
    
        const user = userResults[0];
        if (amount > user.balance) {
          return socket.emit('betResponse', { error: 'Insufficient balance' });
        }
    
        await promiseQuery(
          'UPDATE users SET balance = balance - ? WHERE id = ?',
          [amount, userId]
        );
    
        const betResult = await promiseQuery(
          'INSERT INTO bets (user_id, amount, color) VALUES (?, ?, ?)',
          [userId, amount, color]
        );

        function promiseQuery(sql, values) {
          return new Promise((resolve, reject) => {
            connection.query(sql, values, (error, results) => {
              if (error) reject(error);
              else resolve([results]);
            });
          });
        }
    
        const bet = {
          id: betResult.insertId,
          user_id: userId,
          amount,
          color,
          username: user.username,
          avatar: user.avatar
        };
    
        currentRoundBets.push(bet);
    
        io.emit('currentRoundBets', currentRoundBets);
    
        socket.emit('betResponse', {
          success: true,
          message: `Bet placed on ${color}`,
          newBalance: user.balance - amount
        });
    
      } catch (error) {
        console.error('Error placing bet:', error);
        socket.emit('betResponse', { error: 'Failed to place bet' });
      }
    });
    
    connection.query('SELECT color FROM rolls ORDER BY timestamp DESC LIMIT 20', (error, results) => {
      socket.emit('updateState', { ...gameState, history: results });
    });
  });
});

connection.query(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    username VARCHAR(255) NOT NULL,
    avatar VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

http.listen(3000, () => {
  console.log('Server running on port 3000');
  runGameLoop();
});

process.on('SIGINT', () => {
  connection.end();
  process.exit();
});