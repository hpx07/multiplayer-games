const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

const PORT = 3001;

// ============================================
// SHARED STATE
// ============================================
let players = new Map();
let leaderboard = {
    tictactoe: new Map(),
    bingo: new Map(),
    dotsboxes: new Map()
};

// ============================================
// TIC-TAC-TOE STATE
// ============================================
let tttWaitingPlayer = null;
let tttActiveGames = new Map();

// ============================================
// BINGO STATE
// ============================================
let bingoRoom = {
    host: null,
    players: new Map(),
    calledNumbers: [],
    availableNumbers: [],
    gameActive: false,
    autoCallTimer: null,
    autoCallInterval: 0,
    winners: []
};

// ============================================
// DOTS & BOXES STATE
// ============================================
let dabRooms = new Map(); // roomId -> room data
let dabWaitingPlayers = []; // queue for 2-4 player matchmaking

// ============================================
// EXPRESS SETUP
// ============================================
app.use(express.static('public'));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// SOCKET EVENTS
// ============================================
io.on('connection', (socket) => {
    console.log(`[CONNECT] ${socket.id}`);

    // ── JOIN ──
    socket.on('join', (username) => {
        if (!username || !username.trim()) return socket.emit('joinError', 'Invalid username');
        const taken = Array.from(players.values()).find(p => p.username === username.trim());
        if (taken) return socket.emit('joinError', 'Username already taken');

        players.set(socket.id, {
            id: socket.id,
            username: username.trim(),
            inGame: false,
            currentGame: null
        });

        ['tictactoe', 'bingo', 'dotsboxes'].forEach(game => {
            if (!leaderboard[game].has(username)) {
                leaderboard[game].set(username, { username, wins: 0, losses: 0, draws: 0, points: 0 });
            }
        });

        socket.emit('joined', { username: username.trim() });
        broadcastLobbyUpdate();
        console.log(`[JOIN] ${username}`);
    });

    // ── CHAT ──
    socket.on('chatMessage', (msg) => {
        const p = players.get(socket.id);
        if (!p || !msg.trim()) return;
        io.emit('chatMessage', { username: p.username, message: msg.trim().substring(0, 150), timestamp: Date.now() });
    });

    // ============================================
    // TIC-TAC-TOE EVENTS
    // ============================================
    socket.on('ttt_findMatch', () => {
        const p = players.get(socket.id);
        if (!p || p.inGame) return;
        if (tttWaitingPlayer && tttWaitingPlayer !== socket.id) {
            const wp = players.get(tttWaitingPlayer);
            if (wp && !wp.inGame) {
                ttt_startGame(socket.id, tttWaitingPlayer);
                tttWaitingPlayer = null;
            } else {
                tttWaitingPlayer = socket.id;
                socket.emit('ttt_waiting', 'Searching for opponent...');
            }
        } else {
            tttWaitingPlayer = socket.id;
            socket.emit('ttt_waiting', 'Searching for opponent...');
        }
    });

    socket.on('ttt_cancelSearch', () => {
        if (tttWaitingPlayer === socket.id) tttWaitingPlayer = null;
        socket.emit('ttt_searchCancelled');
    });

    socket.on('ttt_makeMove', ({ gameId, position }) => {
        const game = tttActiveGames.get(gameId);
        if (!game || game.finished) return;
        if (game.currentTurn !== socket.id) return;
        if (game.board[position] !== '') return;
        const symbol = game.player1 === socket.id ? 'X' : 'O';
        game.board[position] = symbol;
        game.moveCount++;
        const winner = ttt_checkWinner(game.board);
        if (winner) {
            ttt_endGame(gameId, winner === 'X' ? game.player1 : game.player2, 'win');
        } else if (game.moveCount === 9) {
            ttt_endGame(gameId, null, 'draw');
        } else {
            game.currentTurn = game.currentTurn === game.player1 ? game.player2 : game.player1;
            ttt_broadcastGameState(gameId);
        }
    });

    socket.on('ttt_startTournament', () => {
        const available = Array.from(players.values()).filter(p => !p.inGame);
        if (available.length < 2) return socket.emit('error', 'Need at least 2 players');
        ttt_startTournament(available);
    });

    socket.on('ttt_rematch', (gameId) => {
        const game = tttActiveGames.get(gameId);
        if (!game) return;
        const opponent = game.player1 === socket.id ? game.player2 : game.player1;
        io.to(opponent).emit('ttt_rematchRequest', socket.id);
    });

    socket.on('ttt_acceptRematch', (requesterId) => {
        ttt_startGame(socket.id, requesterId);
    });

    // ============================================
    // BINGO EVENTS
    // ============================================
    socket.on('bingo_joinRoom', () => {
        const p = players.get(socket.id);
        if (!p) return;
        const card = bingo_generateCard();
        bingoRoom.players.set(socket.id, {
            username: p.username, card,
            markedNumbers: Array(25).fill(null).map((_,i) => i===12 ? true : null),
            hasBingo: false
        });
        if (!bingoRoom.host) {
            bingoRoom.host = socket.id;
            socket.emit('bingo_youAreHost');
        }
        socket.emit('bingo_cardAssigned', {
            card, calledNumbers: bingoRoom.calledNumbers,
            gameActive: bingoRoom.gameActive,
            isHost: bingoRoom.host === socket.id
        });
        bingo_broadcastRoomUpdate();
    });

    socket.on('bingo_leaveRoom', () => bingo_removePlayer(socket.id));

    socket.on('bingo_startGame', () => {
        if (bingoRoom.host !== socket.id) return;
        if (bingoRoom.players.size < 2) return socket.emit('error', 'Need at least 2 players');
        if (bingoRoom.gameActive) return;
        bingoRoom.calledNumbers = [];
        bingoRoom.availableNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
        bingoRoom.winners = [];
        bingoRoom.gameActive = true;
        bingoRoom.players.forEach(pd => {
            pd.markedNumbers = Array(25).fill(null).map((_,i) => i===12 ? true : null);
            pd.hasBingo = false;
        });
        io.emit('bingo_gameStarted');
        bingo_broadcastRoomUpdate();
    });

    socket.on('bingo_callNumber', () => {
        if (bingoRoom.host !== socket.id || !bingoRoom.gameActive || bingoRoom.availableNumbers.length === 0) return;
        const idx = Math.floor(Math.random() * bingoRoom.availableNumbers.length);
        const num = bingoRoom.availableNumbers.splice(idx, 1)[0];
        bingoRoom.calledNumbers.push(num);
        io.emit('bingo_numberCalled', { number: num, calledNumbers: bingoRoom.calledNumbers, remaining: bingoRoom.availableNumbers.length });
    });

    socket.on('bingo_setAutoCall', (interval) => {
        if (bingoRoom.host !== socket.id) return;
        if (bingoRoom.autoCallTimer) { clearInterval(bingoRoom.autoCallTimer); bingoRoom.autoCallTimer = null; }
        bingoRoom.autoCallInterval = interval;
        if (interval > 0 && bingoRoom.gameActive) {
            bingoRoom.autoCallTimer = setInterval(() => {
                if (bingoRoom.availableNumbers.length === 0 || !bingoRoom.gameActive) {
                    clearInterval(bingoRoom.autoCallTimer); bingoRoom.autoCallTimer = null; return;
                }
                const idx = Math.floor(Math.random() * bingoRoom.availableNumbers.length);
                const num = bingoRoom.availableNumbers.splice(idx, 1)[0];
                bingoRoom.calledNumbers.push(num);
                io.emit('bingo_numberCalled', { number: num, calledNumbers: bingoRoom.calledNumbers, remaining: bingoRoom.availableNumbers.length });
            }, interval * 1000);
        }
        io.emit('bingo_autoCallUpdated', interval);
    });

    socket.on('bingo_markNumber', (number) => {
        const pd = bingoRoom.players.get(socket.id);
        if (!pd || !bingoRoom.calledNumbers.includes(number)) return;
        const idx = pd.card.indexOf(number);
        if (idx === -1) return;
        pd.markedNumbers[idx] = true;
        socket.emit('bingo_markConfirmed', { index: idx, number });
        if (bingo_checkWin(pd.markedNumbers) && !pd.hasBingo) {
            pd.hasBingo = true;
            const p = players.get(socket.id);
            bingoRoom.winners.push(p.username);
            const stats = leaderboard.bingo.get(p.username);
            if (stats) { stats.wins++; stats.points += (bingoRoom.winners.length === 1 ? 5 : 3); }
            io.emit('bingo_winner', { username: p.username, position: bingoRoom.winners.length, card: pd.card, markedNumbers: pd.markedNumbers });
            if (bingoRoom.winners.length >= 3 || bingoRoom.availableNumbers.length === 0) bingo_endGame();
        }
    });

    socket.on('bingo_claimBingo', () => {
        const pd = bingoRoom.players.get(socket.id);
        if (!pd || pd.hasBingo) return;
        socket.emit(bingo_checkWin(pd.markedNumbers) ? 'bingo_validClaim' : 'bingo_invalidClaim', 'Not a valid Bingo!');
    });

    socket.on('bingo_resetGame', () => {
        if (bingoRoom.host !== socket.id) return;
        bingo_resetGame();
    });

    // ============================================
    // DOTS & BOXES EVENTS
    // ============================================
    socket.on('dab_joinQueue', (gridSize) => {
        const p = players.get(socket.id);
        if (!p || p.inGame) return;

        // Remove from existing queue if any
        dabWaitingPlayers = dabWaitingPlayers.filter(w => w.id !== socket.id);

        dabWaitingPlayers.push({ id: socket.id, username: p.username, gridSize: gridSize || 4 });
        socket.emit('dab_queued', { position: dabWaitingPlayers.length });

        broadcastLobbyUpdate();
        console.log(`[DAB] ${p.username} joined queue (${dabWaitingPlayers.length} waiting)`);
    });

    socket.on('dab_startWithQueue', (data) => {
        const p = players.get(socket.id);
        if (!p) return;

        const { gridSize, maxPlayers } = data;
        const gs = Math.min(Math.max(gridSize || 4, 3), 7);
        const mp = Math.min(Math.max(maxPlayers || 2, 2), 4);

        // Collect players from queue (include self)
        const allWaiting = dabWaitingPlayers.filter(w => w.id !== socket.id);
        const queuePlayers = [{ id: socket.id, username: p.username }];

        for (let i = 0; i < allWaiting.length && queuePlayers.length < mp; i++) {
            const wp = players.get(allWaiting[i].id);
            if (wp && !wp.inGame) queuePlayers.push({ id: allWaiting[i].id, username: allWaiting[i].username });
        }

        if (queuePlayers.length < 2) {
            return socket.emit('dab_error', 'Need at least 2 players in queue');
        }

        // Remove these players from queue
        const usedIds = queuePlayers.map(p => p.id);
        dabWaitingPlayers = dabWaitingPlayers.filter(w => !usedIds.includes(w.id));

        dab_startGame(queuePlayers, gs);
    });

    socket.on('dab_cancelQueue', () => {
        dabWaitingPlayers = dabWaitingPlayers.filter(w => w.id !== socket.id);
        socket.emit('dab_queueCancelled');
        broadcastLobbyUpdate();
    });

    socket.on('dab_drawLine', ({ roomId, lineKey }) => {
        const room = dabRooms.get(roomId);
        if (!room || room.finished) return;

        const p = players.get(socket.id);
        if (!p) return;

        const currentPlayer = room.playerOrder[room.currentPlayerIndex];
        if (currentPlayer.id !== socket.id) return;

        if (room.lines[lineKey]) return; // already drawn

        // Draw the line
        room.lines[lineKey] = { owner: socket.id, color: currentPlayer.color, username: currentPlayer.username };

        // Check if any boxes were completed
        const completedBoxes = dab_checkBoxes(room, lineKey);
        let extraTurn = completedBoxes.length > 0;

        completedBoxes.forEach(boxKey => {
            room.boxes[boxKey] = { owner: socket.id, color: currentPlayer.color, username: currentPlayer.username };
            currentPlayer.score++;
        });

        // Check game over
        const totalBoxes = room.gridSize * room.gridSize;
        const filledBoxes = Object.keys(room.boxes).length;

        if (filledBoxes >= totalBoxes) {
            dab_endGame(roomId);
        } else {
            if (!extraTurn) {
                room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.playerOrder.length;
            }
            dab_broadcastState(roomId);
        }
    });

    socket.on('dab_leaveRoom', () => {
        dab_removePlayer(socket.id);
    });

    // ── DISCONNECT ──
    socket.on('disconnect', () => {
        const p = players.get(socket.id);
        if (p) {
            console.log(`[DISCONNECT] ${p.username}`);

            tttActiveGames.forEach((game, gameId) => {
                if (game.player1 === socket.id || game.player2 === socket.id) {
                    const opponent = game.player1 === socket.id ? game.player2 : game.player1;
                    io.to(opponent).emit('ttt_opponentDisconnected');
                    const op = players.get(opponent);
                    if (op) op.inGame = false;
                    tttActiveGames.delete(gameId);
                }
            });

            bingo_removePlayer(socket.id);
            dab_removePlayer(socket.id);
            dabWaitingPlayers = dabWaitingPlayers.filter(w => w.id !== socket.id);
            if (tttWaitingPlayer === socket.id) tttWaitingPlayer = null;
            players.delete(socket.id);
        }
        broadcastLobbyUpdate();
    });
});

// ============================================
// TIC-TAC-TOE FUNCTIONS
// ============================================
function ttt_startGame(p1Id, p2Id) {
    const gameId = `ttt_${Date.now()}`;
    const p1 = players.get(p1Id);
    const p2 = players.get(p2Id);
    p1.inGame = true; p1.currentGame = 'tictactoe';
    p2.inGame = true; p2.currentGame = 'tictactoe';
    const game = {
        id: gameId, player1: p1Id, player2: p2Id,
        player1Name: p1.username, player2Name: p2.username,
        board: Array(9).fill(''), currentTurn: p1Id, moveCount: 0, finished: false
    };
    tttActiveGames.set(gameId, game);
    io.to(p1Id).emit('ttt_gameStart', { gameId, opponent: p2.username, symbol: 'X', yourTurn: true });
    io.to(p2Id).emit('ttt_gameStart', { gameId, opponent: p1.username, symbol: 'O', yourTurn: false });
    ttt_broadcastGameState(gameId);
    broadcastLobbyUpdate();
}

function ttt_broadcastGameState(gameId) {
    const game = tttActiveGames.get(gameId);
    if (!game) return;
    const state = { board: game.board, currentTurn: game.currentTurn, player1Name: game.player1Name, player2Name: game.player2Name };
    io.to(game.player1).emit('ttt_gameUpdate', state);
    io.to(game.player2).emit('ttt_gameUpdate', state);
}

function ttt_checkWinner(board) {
    const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for (let [a,b,c] of lines) {
        if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
    }
    return null;
}

function ttt_endGame(gameId, winnerId, result) {
    const game = tttActiveGames.get(gameId);
    if (!game) return;
    game.finished = true;
    const p1 = players.get(game.player1);
    const p2 = players.get(game.player2);
    if (p1) { p1.inGame = false; p1.currentGame = null; }
    if (p2) { p2.inGame = false; p2.currentGame = null; }
    if (result === 'win') {
        const winner = players.get(winnerId);
        const loserId = winnerId === game.player1 ? game.player2 : game.player1;
        const loser = players.get(loserId);
        if (winner) { const ws = leaderboard.tictactoe.get(winner.username); if (ws) { ws.wins++; ws.points += 3; } }
        if (loser) { const ls = leaderboard.tictactoe.get(loser.username); if (ls) ls.losses++; }
        io.to(winnerId).emit('ttt_gameEnd', { result: 'win', gameId });
        io.to(loserId).emit('ttt_gameEnd', { result: 'loss', gameId });
    } else {
        [game.player1, game.player2].forEach(pid => {
            const pl = players.get(pid);
            if (pl) { const s = leaderboard.tictactoe.get(pl.username); if (s) { s.draws++; s.points++; } }
            io.to(pid).emit('ttt_gameEnd', { result: 'draw', gameId });
        });
    }
    setTimeout(() => tttActiveGames.delete(gameId), 1000);
    broadcastLobbyUpdate();
}

function ttt_startTournament(available) {
    const shuffled = [...available].sort(() => Math.random() - 0.5);
    const bracket = [];
    for (let i = 0; i < shuffled.length; i += 2) {
        if (i + 1 < shuffled.length) bracket.push([shuffled[i], shuffled[i+1]]);
    }
    bracket.forEach(pair => ttt_startGame(pair[0].id, pair[1].id));
    io.emit('ttt_tournamentStart', { bracket: bracket.map(p => [p[0].username, p[1].username]) });
}

// ============================================
// BINGO FUNCTIONS
// ============================================
function bingo_generateCard() {
    const card = new Array(25).fill(0);
    const ranges = [[1,15],[16,30],[31,45],[46,60],[61,75]];
    for (let col = 0; col < 5; col++) {
        const [min, max] = ranges[col];
        const nums = [];
        while (nums.length < 5) {
            const n = Math.floor(Math.random() * (max - min + 1)) + min;
            if (!nums.includes(n)) nums.push(n);
        }
        for (let row = 0; row < 5; row++) card[row * 5 + col] = nums[row];
    }
    card[12] = 'FREE';
    return card;
}

function bingo_checkWin(marked) {
    const lines = [
        [0,1,2,3,4],[5,6,7,8,9],[10,11,12,13,14],[15,16,17,18,19],[20,21,22,23,24],
        [0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],[3,8,13,18,23],[4,9,14,19,24],
        [0,6,12,18,24],[4,8,12,16,20]
    ];
    return lines.some(line => line.every(i => marked[i]));
}

function bingo_removePlayer(socketId) {
    if (!bingoRoom.players.has(socketId)) return;
    bingoRoom.players.delete(socketId);
    if (bingoRoom.host === socketId) {
        if (bingoRoom.players.size > 0) {
            bingoRoom.host = bingoRoom.players.keys().next().value;
            io.to(bingoRoom.host).emit('bingo_youAreHost');
            const hd = bingoRoom.players.get(bingoRoom.host);
            io.to(bingoRoom.host).emit('bingo_cardAssigned', { card: hd.card, calledNumbers: bingoRoom.calledNumbers, gameActive: bingoRoom.gameActive, isHost: true });
        } else {
            bingo_resetGame();
            bingoRoom.host = null;
        }
    }
    bingo_broadcastRoomUpdate();
}

function bingo_endGame() {
    bingoRoom.gameActive = false;
    if (bingoRoom.autoCallTimer) { clearInterval(bingoRoom.autoCallTimer); bingoRoom.autoCallTimer = null; }
    bingoRoom.players.forEach((pd, sid) => {
        const p = players.get(sid);
        if (p && !pd.hasBingo) { const s = leaderboard.bingo.get(p.username); if (s) s.losses++; }
    });
    io.emit('bingo_gameEnded', { winners: bingoRoom.winners });
    broadcastLobbyUpdate();
}

function bingo_resetGame() {
    if (bingoRoom.autoCallTimer) { clearInterval(bingoRoom.autoCallTimer); bingoRoom.autoCallTimer = null; }
    bingoRoom.calledNumbers = []; bingoRoom.availableNumbers = [];
    bingoRoom.gameActive = false; bingoRoom.winners = []; bingoRoom.autoCallInterval = 0;
    bingoRoom.players.forEach(pd => {
        pd.card = bingo_generateCard();
        pd.markedNumbers = Array(25).fill(null).map((_,i) => i===12 ? true : null);
        pd.hasBingo = false;
    });
    io.emit('bingo_gameReset');
    bingo_broadcastRoomUpdate();
}

function bingo_broadcastRoomUpdate() {
    io.emit('bingo_roomUpdate', {
        players: Array.from(bingoRoom.players.values()).map(pd => ({ username: pd.username, hasBingo: pd.hasBingo })),
        playerCount: bingoRoom.players.size,
        gameActive: bingoRoom.gameActive,
        calledCount: bingoRoom.calledNumbers.length,
        winners: bingoRoom.winners
    });
}

// ============================================
// DOTS & BOXES FUNCTIONS
// ============================================
const DAB_COLORS = ['#00FF00', '#FF5555', '#FFD700', '#55AAFF'];

function dab_startGame(playerList, gridSize) {
    const roomId = `dab_${Date.now()}`;

    const playerOrder = playerList.map((pl, i) => ({
        id: pl.id,
        username: pl.username,
        color: DAB_COLORS[i],
        score: 0,
        index: i
    }));

    // Mark players as in game
    playerOrder.forEach(pl => {
        const p = players.get(pl.id);
        if (p) { p.inGame = true; p.currentGame = 'dotsboxes'; }
    });

    const room = {
        id: roomId,
        gridSize,
        playerOrder,
        currentPlayerIndex: 0,
        lines: {},   // lineKey -> { owner, color, username }
        boxes: {},   // boxKey -> { owner, color, username }
        finished: false
    };

    dabRooms.set(roomId, room);

    // Notify each player
    playerOrder.forEach((pl, i) => {
        io.to(pl.id).emit('dab_gameStart', {
            roomId,
            gridSize,
            playerOrder: playerOrder.map(p => ({ username: p.username, color: p.color, score: p.score })),
            yourIndex: i,
            yourColor: pl.color,
            currentPlayerIndex: 0
        });
    });

    broadcastLobbyUpdate();
    console.log(`[DAB] Game started: ${playerOrder.map(p => p.username).join(' vs ')} on ${gridSize}x${gridSize} grid`);
}

function dab_checkBoxes(room, drawnLineKey) {
    // Parse the line key to find adjacent boxes
    // Line key format: "h_row_col" for horizontal, "v_row_col" for vertical
    const completed = [];
    const gs = room.gridSize;
    const [type, rStr, cStr] = drawnLineKey.split('_');
    const row = parseInt(rStr), col = parseInt(cStr);

    if (type === 'h') {
        // This horizontal line is the top of box(row, col) and bottom of box(row-1, col)
        // Check box below: needs h_row_col (top), h_row+1_col (bottom), v_row_col (left), v_row_col+1 (right)
        if (row < gs && col < gs) {
            const boxKey = `b_${row}_${col}`;
            if (!room.boxes[boxKey] &&
                room.lines[`h_${row}_${col}`] &&
                room.lines[`h_${row+1}_${col}`] &&
                room.lines[`v_${row}_${col}`] &&
                room.lines[`v_${row}_${col+1}`]) {
                completed.push(boxKey);
            }
        }
        // Check box above
        if (row > 0 && col < gs) {
            const boxKey = `b_${row-1}_${col}`;
            if (!room.boxes[boxKey] &&
                room.lines[`h_${row-1}_${col}`] &&
                room.lines[`h_${row}_${col}`] &&
                room.lines[`v_${row-1}_${col}`] &&
                room.lines[`v_${row-1}_${col+1}`]) {
                completed.push(boxKey);
            }
        }
    } else if (type === 'v') {
        // Vertical line is left of box(row, col) and right of box(row, col-1)
        // Check box to the right
        if (col < gs && row < gs) {
            const boxKey = `b_${row}_${col}`;
            if (!room.boxes[boxKey] &&
                room.lines[`h_${row}_${col}`] &&
                room.lines[`h_${row+1}_${col}`] &&
                room.lines[`v_${row}_${col}`] &&
                room.lines[`v_${row}_${col+1}`]) {
                completed.push(boxKey);
            }
        }
        // Check box to the left
        if (col > 0 && row < gs) {
            const boxKey = `b_${row}_${col-1}`;
            if (!room.boxes[boxKey] &&
                room.lines[`h_${row}_${col-1}`] &&
                room.lines[`h_${row+1}_${col-1}`] &&
                room.lines[`v_${row}_${col-1}`] &&
                room.lines[`v_${row}_${col}`]) {
                completed.push(boxKey);
            }
        }
    }

    return completed;
}

function dab_broadcastState(roomId) {
    const room = dabRooms.get(roomId);
    if (!room) return;
    const state = {
        lines: room.lines,
        boxes: room.boxes,
        currentPlayerIndex: room.currentPlayerIndex,
        scores: room.playerOrder.map(p => ({ username: p.username, score: p.score, color: p.color }))
    };
    room.playerOrder.forEach(pl => io.to(pl.id).emit('dab_gameUpdate', state));
}

function dab_endGame(roomId) {
    const room = dabRooms.get(roomId);
    if (!room) return;
    room.finished = true;

    // Sort by score
    const sorted = [...room.playerOrder].sort((a, b) => b.score - a.score);
    const topScore = sorted[0].score;
    const winners = sorted.filter(p => p.score === topScore);
    const isDraw = winners.length > 1;

    // Update leaderboard
    room.playerOrder.forEach(pl => {
        const stats = leaderboard.dotsboxes.get(pl.username);
        if (!stats) return;
        if (isDraw && winners.find(w => w.id === pl.id)) {
            stats.draws++; stats.points += 1;
        } else if (!isDraw && winners[0].id === pl.id) {
            stats.wins++; stats.points += 3;
        } else {
            stats.losses++;
        }
    });

    // Free players
    room.playerOrder.forEach(pl => {
        const p = players.get(pl.id);
        if (p) { p.inGame = false; p.currentGame = null; }
    });

    const result = {
        finished: true,
        scores: sorted.map(p => ({ username: p.username, score: p.score, color: p.color })),
        winners: winners.map(p => p.username),
        isDraw
    };

    room.playerOrder.forEach(pl => io.to(pl.id).emit('dab_gameEnd', result));
    setTimeout(() => dabRooms.delete(roomId), 5000);
    broadcastLobbyUpdate();
    console.log(`[DAB] Game ended. Winners: ${winners.map(p => p.username).join(', ')}`);
}

function dab_removePlayer(socketId) {
    dabRooms.forEach((room, roomId) => {
        if (room.playerOrder.find(p => p.id === socketId)) {
            const remaining = room.playerOrder.filter(p => p.id !== socketId);
            room.playerOrder.forEach(pl => {
                if (pl.id !== socketId) io.to(pl.id).emit('dab_playerLeft', { message: 'A player left the game' });
                const p = players.get(pl.id);
                if (p) { p.inGame = false; p.currentGame = null; }
            });
            dabRooms.delete(roomId);
        }
    });
}

// ============================================
// SHARED FUNCTIONS
// ============================================
function broadcastLobbyUpdate() {
    const onlinePlayers = Array.from(players.values()).map(p => ({ username: p.username, inGame: p.inGame }));
    const tttBoard = Array.from(leaderboard.tictactoe.values()).sort((a,b) => b.points - a.points).slice(0,10);
    const bingoBoard = Array.from(leaderboard.bingo.values()).sort((a,b) => b.points - a.points).slice(0,10);
    const dabBoard = Array.from(leaderboard.dotsboxes.values()).sort((a,b) => b.points - a.points).slice(0,10);
    io.emit('lobbyUpdate', {
        players: onlinePlayers,
        tttLeaderboard: tttBoard,
        bingoLeaderboard: bingoBoard,
        dabLeaderboard: dabBoard,
        activeGames: tttActiveGames.size,
        bingoPlayers: bingoRoom.players.size,
        dabQueue: dabWaitingPlayers.length
    });
}

http.listen(PORT, () => {
    console.log('='.repeat(60));
    console.log('>> GAME SERVER - Tic-Tac-Toe + Bingo + Dots & Boxes');
    console.log(`>> Port: ${PORT}`);
    console.log(`>> Local: http://localhost:${PORT}`);
    console.log('>> Share your LAN IP with players to connect');
    console.log('='.repeat(60));
});
