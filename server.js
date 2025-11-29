const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// --- 游戏配置 ---
const CARD_TYPES = {
    BOMB: '炸弹',
    DEFUSE: '拆除',
    ATTACK: '攻击',
    SKIP: '跳过',
    FUTURE: '预言',
    PERSPECTIVE: '透视',
    SHUFFLE: '洗牌',
    STEAL: '抽卡',
    NOPE: '否定' // 简单起见作为占位普通牌
};

// --- 全局状态 ---
let players = [];
let deck = []; // 存对象 {type, id}
let discardPile = [];
let turnIndex = 0;
let turnsLeftToTake = 1;
let gameStatus = 'lobby';
let defusingPlayerId = null;

// --- 辅助函数 ---
function sendGameLog(message, type = 'info') {
    io.emit('gameLog', { message, type });
}

function initDeck(playerCount) {
    let d = [];
    // 1. 功能牌
    const types = [CARD_TYPES.ATTACK, CARD_TYPES.SKIP, CARD_TYPES.SHUFFLE, CARD_TYPES.FUTURE, CARD_TYPES.PERSPECTIVE, CARD_TYPES.STEAL];
    types.forEach(type => {
        for(let i=0; i<5; i++) d.push({type, id: Math.random()});
    });
    // 填充一些普通牌
    for(let i=0; i<5; i++) d.push({type: CARD_TYPES.NOPE, id: Math.random()});

    d.sort(() => Math.random() - 0.5);

    // 2. 发牌
    players.forEach(p => {
        p.hand = [{type: CARD_TYPES.DEFUSE, id: Math.random()}];
        for(let i=0; i<4; i++) if(d.length) p.hand.push(d.pop());
        p.isAlive = true;
        p.attackCount = 0; // 被甩锅的次数
    });

    // 3. 放入炸弹 (与人数相等)
    for(let i=0; i < playerCount; i++) d.push({type: CARD_TYPES.BOMB, id: Math.random()});

    // 4. 放入剩余拆除 (假设总共6张)
    let extraDefuse = 6 - playerCount;
    for(let i=0; i<extraDefuse; i++) d.push({type: CARD_TYPES.DEFUSE, id: Math.random()});

    return d.sort(() => Math.random() - 0.5);
}

function nextTurn(attacks = 0) {
    const alive = players.filter(p => p.isAlive);
    if (alive.length === 1) {
        gameStatus = 'gameover';
        sendGameLog(`🎉 ${alive[0].name} 获得胜利！`, 'win');
        io.emit('gameOver', alive[0].name);
        return;
    }

    if (attacks > 0) turnsLeftToTake = (turnsLeftToTake - 1) + 2; // 累加规则
    else {
        if (turnsLeftToTake > 1) {
            turnsLeftToTake--;
            updateGame(); // 还是当前玩家
            return;
        } else {
            turnsLeftToTake = 1;
        }
    }

    do {
        turnIndex = (turnIndex + 1) % players.length;
    } while (!players[turnIndex].isAlive);

    // 检查新的当前玩家是否被甩锅
    const currentPlayer = players[turnIndex];
    if(currentPlayer.attackCount > 0) {
        turnsLeftToTake += currentPlayer.attackCount;
        currentPlayer.attackCount = 0;
    }

    updateGame();
}

function updateGame(log = "") {
    // 计算牌堆中的炸弹数量
    const bombsInDeck = deck.filter(c => c.type === CARD_TYPES.BOMB).length;

    const state = {
        gameStatus,
        currentPlayerId: players[turnIndex] ? players[turnIndex].id : null,
        turnsLeft: turnsLeftToTake,
        deckCount: deck.length, // 关键：前端根据这个数字渲染3D厚度
        bombsInDeck: bombsInDeck, // 牌堆中的炸弹数量
        discardPileTop: discardPile.length > 0 ? discardPile[discardPile.length-1] : null,
        players: players.map(p => ({
            id: p.id,
            name: p.name,
            cardCount: p.hand.length,
            isAlive: p.isAlive,
            isHost: p.isHost,
            attackCount: p.attackCount || 0
        })),
        log
    };

    io.emit('gameState', state);
    players.forEach(p => io.to(p.id).emit('handUpdate', p.hand));
}

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        if(gameStatus !== 'lobby') return;

        // 检查该玩家是否已经加入
        const existingPlayer = players.find(p => p.id === socket.id);
        if(existingPlayer) {
            // 已经加入，只更新名字
            existingPlayer.name = name;
            io.emit('playerList', players);
            return;
        }

        const isHost = players.length === 0;
        players.push({ id: socket.id, name, hand: [], isAlive: true, isHost });
        sendGameLog(`${name} 加入了游戏${isHost ? ' (房主)' : ''}`, 'join');
        io.emit('playerList', players);
    });

    socket.on('start', () => {
        if(players.length < 2) return;
        turnIndex = 0;
        turnsLeftToTake = 1;
        deck = initDeck(players.length);
        gameStatus = 'playing';
        sendGameLog(`🎮 游戏开始！共 ${players.length} 名玩家，牌堆中有 ${players.length} 颗炸弹`, 'info');
        updateGame("游戏开始！炸弹已埋好...");
    });

    socket.on('draw', () => {
        if(gameStatus !== 'playing' || socket.id !== players[turnIndex].id) return;

        const card = deck.pop();
        if(!card) return;

        const p = players.find(p => p.id === socket.id);

        if(card.type === CARD_TYPES.BOMB) {
            const defuseIdx = p.hand.findIndex(c => c.type === CARD_TYPES.DEFUSE);

            if(defuseIdx !== -1) {
                p.hand.splice(defuseIdx, 1);
                discardPile.push({type: CARD_TYPES.DEFUSE});
                gameStatus = 'defusing';
                defusingPlayerId = socket.id;
                sendGameLog(`💥 ${p.name} 摸到了炸弹！使用拆除卡拆除`, 'defuse');
                updateGame(`💥 ${p.name} 摸到了炸弹！使用拆除卡！`);
                socket.emit('askBombPosition', deck.length);
            } else {
                p.isAlive = false;
                discardPile.push(card);
                sendGameLog(`☠️ ${p.name} 被炸飞了！`, 'bomb');
                updateGame(`☠️ ${p.name} 被炸飞了！`);
                nextTurn();
            }
        } else {
            p.hand.push(card);
            sendGameLog(`${p.name} 摸了一张牌`, 'draw');
            nextTurn();
        }
    });

    socket.on('play', (data) => {
        const index = typeof data === 'number' ? data : data.index;
        const targetId = data.targetId;

        if(gameStatus !== 'playing' || socket.id !== players[turnIndex].id) return;
        const p = players.find(p => p.id === socket.id);
        const card = p.hand[index];

        if(!card || card.type === CARD_TYPES.DEFUSE || card.type === CARD_TYPES.BOMB) return; // 不能直接出

        // 需要选择目标的牌
        if([CARD_TYPES.ATTACK, CARD_TYPES.STEAL, CARD_TYPES.NOPE].includes(card.type)) {
            if(!targetId) {
                // 需要选择目标，发送事件让客户端选择
                socket.emit('selectTarget', { cardIndex: index, cardType: card.type });
                return;
            }
        }

        p.hand.splice(index, 1);
        discardPile.push(card);

        let msg = `${p.name} 使用了 ${card.type}`;

        if(card.type === CARD_TYPES.ATTACK) {
            // 甩锅：给目标玩家增加攻击次数
            const target = players.find(p => p.id === targetId && p.isAlive);
            if(target) {
                target.attackCount = (target.attackCount || 0) + 1;
                msg += ` 对 ${target.name}`;
                sendGameLog(`🍳 ${p.name} 甩锅给 ${target.name}！`, 'attack');
            }
            nextTurn();
        }
        else if(card.type === CARD_TYPES.SKIP) {
            turnsLeftToTake--;
            sendGameLog(`⏭️ ${p.name} 跳过了回合`, 'play');
            if(turnsLeftToTake===0) nextTurn();
            else updateGame(msg);
        }
        else if(card.type === CARD_TYPES.FUTURE) {
            // 预言：告诉玩家炸弹在第几张
            const futureCards = deck.slice(-3).reverse();
            const bombIndex = futureCards.findIndex(c => c.type === CARD_TYPES.BOMB);

            if(bombIndex !== -1) {
                const position = bombIndex + 1; // 转换为1-based索引
                socket.emit('showFutureText', `🔮 预言：炸弹在接下来的第 ${position} 张牌！`);
                sendGameLog(`🔮 ${p.name} 使用预言，发现了炸弹的位置`, 'play');
            } else {
                socket.emit('showFutureText', `🔮 预言：接下来的3张牌中没有炸弹，安全！`);
                sendGameLog(`🔮 ${p.name} 使用预言查看未来`, 'play');
            }
            updateGame(msg);
        }
        else if(card.type === CARD_TYPES.PERSPECTIVE) {
            // 透视：显示前三张牌的牌面
            socket.emit('showFuture', deck.slice(-3).reverse());
            sendGameLog(`👁️ ${p.name} 使用透视查看牌堆顶部三张牌`, 'play');
            updateGame(msg);
        }
        else if(card.type === CARD_TYPES.SHUFFLE) {
            deck.sort(()=>Math.random()-0.5);
            sendGameLog(`🔀 ${p.name} 使用洗牌重新洗牌`, 'play');
            updateGame(msg);
        }
        else if(card.type === CARD_TYPES.STEAL) {
            // 索要：让目标玩家选一张牌给出
            const target = players.find(p => p.id === targetId && p.isAlive);
            if(target && target.hand.length > 0) {
                msg += ` 对 ${target.name}`;
                sendGameLog(`🎯 ${p.name} 向 ${target.name} 索要一张牌`, 'play');
                updateGame(msg);
                io.to(targetId).emit('giveCard', { requesterId: socket.id, requesterName: p.name });
            } else {
                updateGame(msg);
            }
        }
        else if(card.type === CARD_TYPES.NOPE) {
            // 交换：两人手牌互换
            const target = players.find(p => p.id === targetId && p.isAlive);
            if(target) {
                const temp = p.hand;
                p.hand = target.hand;
                target.hand = temp;
                msg += ` 与 ${target.name} 交换手牌`;
                sendGameLog(`🔄 ${p.name} 与 ${target.name} 交换了手牌`, 'play');
                updateGame(msg);
                // 更新双方手牌
                io.to(p.id).emit('handUpdate', p.hand);
                io.to(target.id).emit('handUpdate', target.hand);
            } else {
                updateGame(msg);
            }
        }
        else {
            sendGameLog(`${p.name} 使用了 ${card.type}`, 'play');
            updateGame(msg);
        }
    });

    socket.on('giveCardResponse', (data) => {
        // 被索要的玩家给出一张牌
        const giver = players.find(p => p.id === socket.id);
        const receiver = players.find(p => p.id === data.requesterId);

        if(!giver || !receiver || !giver.hand[data.cardIndex]) return;

        const card = giver.hand.splice(data.cardIndex, 1)[0];
        receiver.hand.push(card);

        sendGameLog(`${giver.name} 给了 ${receiver.name} 一张牌`, 'play');
        updateGame(`${giver.name} 给了 ${receiver.name} 一张牌`);
        io.to(giver.id).emit('handUpdate', giver.hand);
        io.to(receiver.id).emit('handUpdate', receiver.hand);
    });

    socket.on('insertBomb', (position) => {
        if(gameStatus !== 'defusing' || socket.id !== defusingPlayerId) return;
        // position: 0=牌顶(下张), 1=第二张, 2=第三张, -1=牌底
        // deck.pop() 从末尾摸牌，所以：
        // - 牌顶(0) 对应 deck.length (末尾)
        // - 第二张(1) 对应 deck.length - 1
        // - 第三张(2) 对应 deck.length - 2
        // - 牌底(-1) 对应 0 (开头)

        const p = players.find(p => p.id === socket.id);
        let pos;
        let posDesc;

        if(position === -1) {
            // 牌底
            pos = 0;
            posDesc = '牌底';
        } else if(position === 0) {
            // 牌顶（下张）
            pos = deck.length;
            posDesc = '牌顶（下张）';
        } else if(position === 1) {
            // 第二张
            pos = Math.max(0, deck.length - 1);
            posDesc = '第二张';
        } else if(position === 2) {
            // 第三张
            pos = Math.max(0, deck.length - 2);
            posDesc = '第三张';
        }

        deck.splice(pos, 0, {type: CARD_TYPES.BOMB, id: Math.random()});
        gameStatus = 'playing';
        defusingPlayerId = null;

        // 给所有玩家发送模糊信息
        sendGameLog(`${p.name} 将炸弹悄悄放回了牌堆`, 'defuse');

        // 只给拆除者本人发送详细位置（私密消息）
        io.to(socket.id).emit('gameLog', {
            message: `💡 你将炸弹放回了${posDesc}`,
            type: 'defuse'
        });

        updateGame("炸弹已悄悄放回...");
        nextTurn();
    });

    socket.on('disconnect', () => {
        const player = players.find(p => p.id === socket.id);
        if(player) {
            sendGameLog(`${player.name} 离开了游戏`, 'leave');
        }
        players = players.filter(p => p.id !== socket.id);
        if(players.length===0) { gameStatus='lobby'; players=[]; }
        io.emit('playerList', players);
    });
});

const PORT = 3004;
server.listen(PORT, () => console.log(`Listening on ${PORT}`));