const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 8000,
  pingInterval: 3000,
  transports: ["polling"],
});

app.use(express.static("public"));

let players = {};
let playerIds = [];
let turnIndex = 0;
let currentBet = null; // { quantity, face, playerId }
let gameActive = false;

function rollDice(count) {
  return Array.from({ length: count }, () => Math.floor(Math.random() * 6) + 1);
}

function nextTurn() {
  do {
    turnIndex = (turnIndex + 1) % playerIds.length;
  } while (players[playerIds[turnIndex]].poisons >= 2); // Pula quem já morreu
  io.emit("updateTurn", playerIds[turnIndex]);
}

io.on("connection", (socket) => {
  console.log("Jogador conectado:", socket.id);

  // Send current lobby state to anyone who connects
  socket.emit("updatePlayers", Object.values(players));

  socket.on("joinGame", (payload) => {
    if (gameActive) return socket.emit("errorMsg", "Jogo já em andamento.");
    const name = (typeof payload === "string" ? payload : payload.name || "?").slice(0, 12);
    const icon = typeof payload === "object" && payload.icon ? String(payload.icon).slice(0, 8) : "🎲";

    // Remove stale entry with same name (e.g. after F5 before old socket timed out)
    const staleId = playerIds.find((id) => players[id] && players[id].name === name);
    if (staleId) {
      delete players[staleId];
      playerIds = playerIds.filter((id) => id !== staleId);
    }

    players[socket.id] = { id: socket.id, name, icon, dice: [], poisons: 0 };
    playerIds.push(socket.id);
    io.emit("updatePlayers", Object.values(players));
  });

  socket.on("startGame", () => {
    if (playerIds.length < 2) return;
    gameActive = true;
    playerIds.forEach((id) => {
      players[id].dice = rollDice(5);
      players[id].poisons = 0; // 0 venenos = 2 vidas intactas
    });
    turnIndex = 0;
    currentBet = null;

    // Envia os dados privados para cada jogador
    playerIds.forEach((id) => io.to(id).emit("gameStarted", players[id].dice));
    io.emit("updateTurn", playerIds[turnIndex]);
  });

  socket.on("placeBet", (bet) => {
    if (socket.id !== playerIds[turnIndex]) return;

    // Validação da aposta (precisa ser maior)
    if (currentBet) {
      if (bet.quantity < currentBet.quantity && bet.face <= currentBet.face)
        return;
      if (bet.quantity === currentBet.quantity && bet.face <= currentBet.face)
        return;
    }

    currentBet = { ...bet, playerId: socket.id };
    io.emit("betPlaced", currentBet, players[socket.id]);
    nextTurn();
  });

  socket.on("callLiar", () => {
    if (socket.id !== playerIds[turnIndex] || !currentBet) return;

    // Revela todos os dados para a mesa
    io.emit("revealDice", players);

    // Conta quantos dados daquela face existem (Modo Básico)
    let totalFace = 0;
    playerIds.forEach((id) => {
      if (players[id].poisons < 2) {
        totalFace += players[id].dice.filter(
          (d) => d === currentBet.face,
        ).length;
      }
    });

    let loserId = null;
    let resultMsg = `Havia ${totalFace} dados de valor ${currentBet.face}. `;

    if (totalFace >= currentBet.quantity) {
      // Aposta era verdade. Quem chamou de mentiroso bebe veneno.
      loserId = socket.id;
      resultMsg += `${players[socket.id].name} acusou errado e bebeu veneno!`;
    } else {
      // Aposta era mentira. Quem apostou bebe veneno.
      loserId = currentBet.playerId;
      resultMsg += `${players[currentBet.playerId].name} blefou e bebeu veneno!`;
    }

    players[loserId].poisons += 1;
    io.emit("roundResult", resultMsg, players);

    // Verifica eliminação
    if (players[loserId].poisons >= 2) {
      io.emit("playerEliminated", players[loserId].name);
    }

    // Reseta para a próxima rodada após 5 segundos
    setTimeout(() => {
      let vivos = playerIds.filter((id) => players[id].poisons < 2);
      if (vivos.length <= 1) {
        io.emit("gameOver", players[vivos[0]].name);
        gameActive = false;
        currentBet = null;
      } else {
        currentBet = null;
        playerIds.forEach((id) => {
          if (players[id].poisons < 2) {
            players[id].dice = rollDice(5);
            io.to(id).emit("gameStarted", players[id].dice);
          }
        });
        turnIndex = playerIds.indexOf(loserId);
        if (players[loserId].poisons >= 2) nextTurn(); // Se o perdedor morreu, passa a vez
        io.emit("newRound");
        io.emit("updateTurn", playerIds[turnIndex]);
      }
    }, 5000);
  });

  socket.on("sendReaction", (emoji) => {
    if (!players[socket.id]) return;
    const safe = String(emoji).slice(0, 8);
    const p = players[socket.id];
    io.emit("reaction", { emoji: safe, playerName: `${p.icon} ${p.name}` });
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    playerIds = playerIds.filter((id) => id !== socket.id);
    io.emit("updatePlayers", Object.values(players));
  });
});

server.listen(3000, () => {
  console.log("Servidor rodando em http://localhost:3000");
});
