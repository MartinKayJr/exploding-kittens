const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// --- 项目配置 ---
const CARD_TYPES = {
    BOMB: '炸弹',
    DEFUSE: '拆除',
    ATTACK: '攻击',
    ATTACK_2X: '甩锅x2',
    SKIP: '跳过',
    FUTURE: '预言',
    PERSPECTIVE: '透视',
    SHUFFLE: '洗牌',
    STEAL: '索要',
    DRAW_BOTTOM: '抽底',
    SWAP: '交换',
    NOPE: '否定'
};

// --- 全局状态 ---
let players = [];
let deck = []; // 存对象 {type, id}
let discardPile = [];
let turnIndex = 0;
let turnsLeftToTake = 1;
let gameStatus = 'lobby';
let defusingPlayerId = null;

// 否定卡机制
let pendingAction = null; // 待处理的动作 {type, playerId, data, canBeNoped}
let nopeWindow = null; // 否定响应的定时器
let nopeChain = []; // 否定链：[{playerId, playerName}]
const NOPE_WAIT_TIME = 3000; // 等待否定的时间（毫秒）

// --- 辅助函数 ---
function sendGameLog(message, type = 'info') {
    io.emit('gameLog', { message, type });
}

// 否定卡机制函数
function startNopeWindow(action) {
    pendingAction = action;
    nopeChain = [];

    // 获取卡牌中文名称
    const cardTypeMap = {
        'attack': '甩锅',
        'attack_2x': '甩锅x2',
        'skip': '跳过',
        'future': '预言',
        'perspective': '透视',
        'shuffle': '洗牌',
        'steal': '索要',
        'draw_bottom': '抽底',
        'swap': '交换'
    };
    const cardName = cardTypeMap[action.type] || action.type;

    // 广播等待否定事件
    io.emit('nopeWindowStart', {
        action: action.type,
        cardName: cardName,
        playerName: action.playerName,
        targetName: action.data?.targetName || null,
        isSelfTarget: action.data?.isSelfAttack || false,
        waitTime: NOPE_WAIT_TIME
    });

    sendGameLog(`等待否定... (${NOPE_WAIT_TIME/1000}秒)`, 'nope');

    // 设置定时器，时间到后执行动作
    nopeWindow = setTimeout(() => {
        executeOrCancelAction();
    }, NOPE_WAIT_TIME);
}

function executeOrCancelAction() {
    if (!pendingAction) return;

    const nopedCount = nopeChain.length;
    const isCancelled = nopedCount % 2 === 1; // 奇数次否定 = 取消

    // 广播否定窗口结束
    io.emit('nopeWindowEnd', {
        nopedCount,
        isCancelled,
        nopeChain
    });

    if (isCancelled) {
        sendGameLog(`动作被否定！(否定次数: ${nopedCount})`, 'nope');
    } else {
        if (nopedCount > 0) {
            sendGameLog(`否定被否定！动作继续执行 (否定次数: ${nopedCount})`, 'nope');
        }
        // 执行原动作
        executeAction(pendingAction);
    }

    // 清理
    pendingAction = null;
    nopeChain = [];
    nopeWindow = null;
}

function executeAction(action) {
    // 执行动作的回调函数
    if (action && action.executeCallback) {
        action.executeCallback();
    }
}

function initDeck(playerCount) {
    let d = [];
    // 1. 甩锅卡（较多数量，游戏核心卡牌）
    for(let i=0; i<8; i++) d.push({type: CARD_TYPES.ATTACK, id: Math.random()});
    for(let i=0; i<5; i++) d.push({type: CARD_TYPES.ATTACK_2X, id: Math.random()});

    // 2. 抽底卡（较多数量，重要防御卡）
    for(let i=0; i<7; i++) d.push({type: CARD_TYPES.DRAW_BOTTOM, id: Math.random()});

    // 3. 其他功能牌
    const types = [CARD_TYPES.SKIP, CARD_TYPES.SHUFFLE, CARD_TYPES.FUTURE, CARD_TYPES.PERSPECTIVE, CARD_TYPES.STEAL];
    types.forEach(type => {
        for(let i=0; i<5; i++) d.push({type, id: Math.random()});
    });

    // 4. 交换卡和否定卡
    for(let i=0; i<4; i++) d.push({type: CARD_TYPES.SWAP, id: Math.random()});
    for(let i=0; i<5; i++) d.push({type: CARD_TYPES.NOPE, id: Math.random()});

    d.sort(() => Math.random() - 0.5);

    // 4. 发牌给每位玩家
    players.forEach(p => {
        p.hand = [{type: CARD_TYPES.DEFUSE, id: Math.random()}];
        for(let i=0; i<4; i++) if(d.length) p.hand.push(d.pop());
        p.isAlive = true;
    });

    // 5. 放入炸弹 (与人数相等)
    for(let i=0; i < playerCount; i++) d.push({type: CARD_TYPES.BOMB, id: Math.random()});

    // 6. 放入剩余拆除 (假设总共6张)
    let extraDefuse = 6 - playerCount;
    for(let i=0; i<extraDefuse; i++) d.push({type: CARD_TYPES.DEFUSE, id: Math.random()});

    return d.sort(() => Math.random() - 0.5);
}

function nextTurn() {
    const alive = players.filter(p => p.isAlive);
    if (alive.length === 1) {
        gameStatus = 'gameover';
        sendGameLog(`🎉 ${alive[0].name} 获得胜利！`, 'win');
        io.emit('gameOver', alive[0].name);
        return;
    }

    // 处理剩余回合数
    if (turnsLeftToTake > 1) {
        turnsLeftToTake--;
        updateGame(); // 还是当前玩家
        return;
    } else {
        turnsLeftToTake = 1;
    }

    // 切换到下一个存活的玩家
    do {
        turnIndex = (turnIndex + 1) % players.length;
    } while (!players[turnIndex].isAlive);

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
            isHost: p.isHost
        })),
        log
    };

    io.emit('gameState', state);
    players.forEach(p => io.to(p.id).emit('handUpdate', p.hand));
}

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        if(gameStatus !== 'lobby') {
            socket.emit('gameLog', { message: '项目已开始，无法加入！', type: 'error' });
            return;
        }

        // 检查名字是否为空
        if(!name || name.trim() === '') {
            socket.emit('gameLog', { message: '名字不能为空！', type: 'error' });
            return;
        }

        const trimmedName = name.trim();

        // 检查该玩家是否已经加入
        const existingPlayer = players.find(p => p.id === socket.id);
        if(existingPlayer) {
            // 已经加入，检查是否要改名
            if(existingPlayer.name !== trimmedName) {
                // 检查新名字是否被其他人使用
                const nameTaken = players.find(p => p.id !== socket.id && p.name === trimmedName);
                if(nameTaken) {
                    socket.emit('gameLog', { message: '该名字已被使用，请换一个！', type: 'error' });
                    return;
                }
                existingPlayer.name = trimmedName;
            }
            io.emit('playerList', players);
            return;
        }

        // 检查名字是否已被使用
        const nameTaken = players.find(p => p.name === trimmedName);
        if(nameTaken) {
            socket.emit('gameLog', { message: '该名字已被使用，请换一个！', type: 'error' });
            socket.emit('nameRejected', { reason: '名字已被使用' });
            return;
        }

        const isHost = players.length === 0;
        players.push({ id: socket.id, name: trimmedName, hand: [], isAlive: true, isHost });
        sendGameLog(`${trimmedName} 加入了项目${isHost ? ' (房主)' : ''}`, 'join');
        io.emit('playerList', players);
        socket.emit('nameAccepted');
    });

    socket.on('start', () => {
        const player = players.find(p => p.id === socket.id);

        // 只有房主可以开始项目
        if(!player || !player.isHost) {
            socket.emit('gameLog', { message: '只有房主可以开始项目！', type: 'error' });
            return;
        }

        if(players.length < 2) {
            socket.emit('gameLog', { message: '至少需要2名玩家才能开始项目！', type: 'error' });
            return;
        }

        turnIndex = 0;
        turnsLeftToTake = 1;
        deck = initDeck(players.length);
        gameStatus = 'playing';
        sendGameLog(`🎮 项目开始！共 ${players.length} 名玩家，牌堆中有 ${players.length} 颗炸弹`, 'info');
        updateGame("项目开始！炸弹已埋好...");
    });

    socket.on('draw', () => {
        if(gameStatus !== 'playing' || socket.id !== players[turnIndex].id) return;

        const card = deck.pop();
        if(!card) return;

        const p = players.find(p => p.id === socket.id);

        // 广播抽到的牌（显示在出牌区）
        io.emit('cardPlayed', {
            cardType: card.type,
            playerName: `${p.name} 抽到`,
            playerId: p.id
        });

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
        if([CARD_TYPES.ATTACK, CARD_TYPES.ATTACK_2X, CARD_TYPES.STEAL, CARD_TYPES.SWAP].includes(card.type)) {
            if(!targetId) {
                // 需要选择目标，发送事件让客户端选择
                socket.emit('selectTarget', { cardIndex: index, cardType: card.type });
                return;
            }

            // 验证目标玩家是否存活（在移除卡牌之前）
            const target = players.find(pl => pl.id === targetId);
            if(!target || !target.isAlive) {
                socket.emit('gameLog', { message: '目标玩家已死亡，无法对其使用卡牌！', type: 'error' });
                return;
            }
        }

        p.hand.splice(index, 1);
        discardPile.push(card);

        // 广播出牌信息到所有客户端（用于显示出牌区）
        io.emit('cardPlayed', {
            cardType: card.type,
            playerName: p.name,
            playerId: p.id
        });

        let msg = `${p.name} 使用了 ${card.type}`;

        if(card.type === CARD_TYPES.ATTACK) {
            // 甩锅（x1）：跳过自己的摸牌，立即切换回合到目标玩家，目标需要抽牌次数+1
            const target = players.find(pl => pl.id === targetId && pl.isAlive);
            if(!target) {
                nextTurn();
                return;
            }

            const isSelfAttack = p.id === targetId;
            const currentTurns = turnsLeftToTake;
            const currentTurnIdx = turnIndex;

            // 创建执行回调（被否定后不会执行）
            const executeCallback = () => {
                if(isSelfAttack) {
                    // 甩锅给自己：增加自己的摸牌次数
                    turnsLeftToTake = currentTurns + 1;
                    sendGameLog(`🍳 ${p.name} 甩锅给自己！增加摸牌次数`, 'attack');
                    sendGameLog(`${p.name} 需要出牌 ${turnsLeftToTake} 次（摸牌或跳过）`, 'attack');
                    updateGame(msg + ` 对自己`);
                } else {
                    // 甩锅给别人
                    sendGameLog(`🍳 ${p.name} 甩锅给 ${target.name}！`, 'attack');

                    // 找到目标玩家的索引
                    const targetIndex = players.findIndex(pl => pl.id === targetId);
                    if(targetIndex !== -1) {
                        // 立即切换到目标玩家
                        turnIndex = targetIndex;
                        // x1 甩锅：累加1次（而不是直接设置为1）
                        turnsLeftToTake = currentTurns + 1;
                        sendGameLog(`${target.name} 需要出牌 ${turnsLeftToTake} 次（摸牌或跳过）`, 'attack');
                        updateGame(msg + ` 对 ${target.name}`);
                    } else {
                        nextTurn();
                    }
                }
            };

            // 启动否定窗口
            startNopeWindow({
                type: 'attack',
                playerId: p.id,
                playerName: p.name,
                data: { targetId, targetName: target.name, isSelfAttack },
                executeCallback
            });
        }
        else if(card.type === CARD_TYPES.ATTACK_2X) {
            // 双重甩锅（x2）：跳过自己的摸牌，立即切换回合到目标玩家，目标需要抽牌次数+2
            const target = players.find(pl => pl.id === targetId && pl.isAlive);
            if(!target) {
                nextTurn();
                return;
            }

            const isSelfAttack = p.id === targetId;
            const currentTurns = turnsLeftToTake;

            // 创建执行回调
            const executeCallback = () => {
                if(isSelfAttack) {
                    // 甩锅给自己：增加自己的摸牌次数
                    turnsLeftToTake = currentTurns + 2;
                    sendGameLog(`🍳🍳 ${p.name} 双重甩锅给自己！增加摸牌次数`, 'attack');
                    sendGameLog(`${p.name} 需要出牌 ${turnsLeftToTake} 次（摸牌或跳过）`, 'attack');
                    updateGame(msg + ` 对自己`);
                } else {
                    // 甩锅给别人
                    sendGameLog(`🍳🍳 ${p.name} 双重甩锅给 ${target.name}！`, 'attack');

                    // 找到目标玩家的索引
                    const targetIndex = players.findIndex(pl => pl.id === targetId);
                    if(targetIndex !== -1) {
                        // 立即切换到目标玩家
                        turnIndex = targetIndex;
                        // x2 甩锅：累加2次
                        turnsLeftToTake = currentTurns + 2;
                        sendGameLog(`${target.name} 需要出牌 ${turnsLeftToTake} 次（摸牌或跳过）`, 'attack');
                        updateGame(msg + ` 对 ${target.name}`);
                    } else {
                        nextTurn();
                    }
                }
            };

            // 启动否定窗口
            startNopeWindow({
                type: 'attack_2x',
                playerId: p.id,
                playerName: p.name,
                data: { targetId, targetName: target.name, isSelfAttack },
                executeCallback
            });
        }
        else if(card.type === CARD_TYPES.SKIP) {
            // 跳过：减少一次摸牌次数
            const currentTurns = turnsLeftToTake;

            // 创建执行回调
            const executeCallback = () => {
                turnsLeftToTake = currentTurns - 1;
                if(turnsLeftToTake === 0) {
                    sendGameLog(`⏭️ ${p.name} 跳过了回合`, 'play');
                    nextTurn();
                } else {
                    sendGameLog(`⏭️ ${p.name} 跳过了1次，还需要出牌 ${turnsLeftToTake} 次`, 'play');
                    updateGame(msg);
                }
            };

            // 启动否定窗口
            startNopeWindow({
                type: 'skip',
                playerId: p.id,
                playerName: p.name,
                data: {},
                executeCallback
            });
        }
        else if(card.type === CARD_TYPES.FUTURE) {
            // 预言：告诉玩家炸弹在第几张
            const playerId = socket.id;

            // 创建执行回调
            const executeCallback = () => {
                const futureCards = deck.slice(-3).reverse();
                const bombIndex = futureCards.findIndex(c => c.type === CARD_TYPES.BOMB);

                if(bombIndex !== -1) {
                    const position = bombIndex + 1; // 转换为1-based索引
                    io.to(playerId).emit('showFutureText', `🔮 预言：炸弹在接下来的第 ${position} 张牌！`);
                    sendGameLog(`🔮 ${p.name} 使用预言，发现了炸弹的位置`, 'play');
                } else {
                    io.to(playerId).emit('showFutureText', `🔮 预言：接下来的3张牌中没有炸弹，安全！`);
                    sendGameLog(`🔮 ${p.name} 使用预言查看未来`, 'play');
                }
                updateGame(msg);
            };

            // 启动否定窗口
            startNopeWindow({
                type: 'future',
                playerId: p.id,
                playerName: p.name,
                data: {},
                executeCallback
            });
        }
        else if(card.type === CARD_TYPES.PERSPECTIVE) {
            // 透视：显示前三张牌的牌面
            const playerId = socket.id;

            // 创建执行回调
            const executeCallback = () => {
                io.to(playerId).emit('showFuture', deck.slice(-3).reverse());
                sendGameLog(`👁️ ${p.name} 使用透视查看牌堆顶部三张牌`, 'play');
                updateGame(msg);
            };

            // 启动否定窗口
            startNopeWindow({
                type: 'perspective',
                playerId: p.id,
                playerName: p.name,
                data: {},
                executeCallback
            });
        }
        else if(card.type === CARD_TYPES.SHUFFLE) {
            // 洗牌：重新洗牌堆

            // 创建执行回调
            const executeCallback = () => {
                deck.sort(() => Math.random() - 0.5);
                sendGameLog(`🔀 ${p.name} 使用洗牌重新洗牌`, 'play');
                updateGame(msg);
            };

            // 启动否定窗口
            startNopeWindow({
                type: 'shuffle',
                playerId: p.id,
                playerName: p.name,
                data: {},
                executeCallback
            });
        }
        else if(card.type === CARD_TYPES.STEAL) {
            // 索要：让目标玩家选一张牌给出
            const target = players.find(p => p.id === targetId && p.isAlive);
            if(!target) {
                updateGame(msg);
                return;
            }

            const requesterId = socket.id;
            const requesterName = p.name;
            const targetPlayerId = targetId;
            const targetPlayerName = target.name;

            // 创建执行回调
            const executeCallback = () => {
                // 再次检查目标是否还有手牌
                const currentTarget = players.find(p => p.id === targetPlayerId && p.isAlive);
                if(currentTarget && currentTarget.hand.length > 0) {
                    sendGameLog(`🎯 ${requesterName} 向 ${targetPlayerName} 索要一张牌`, 'play');
                    updateGame(msg + ` 对 ${targetPlayerName}`);
                    io.to(targetPlayerId).emit('giveCard', { requesterId, requesterName });
                } else {
                    sendGameLog(`🎯 ${requesterName} 索要失败（目标没有牌）`, 'play');
                    updateGame(msg);
                }
            };

            // 启动否定窗口
            startNopeWindow({
                type: 'steal',
                playerId: p.id,
                playerName: p.name,
                data: { targetId: targetPlayerId, targetName: targetPlayerName },
                executeCallback
            });
        }
        else if(card.type === CARD_TYPES.SWAP) {
            // 交换：两人手牌互换
            const target = players.find(p => p.id === targetId && p.isAlive);
            if(!target) {
                updateGame(msg);
                return;
            }

            const playerId = socket.id;
            const playerName = p.name;
            const targetPlayerId = targetId;
            const targetPlayerName = target.name;

            // 创建执行回调
            const executeCallback = () => {
                // 找到当前的玩家对象
                const currentPlayer = players.find(p => p.id === playerId);
                const currentTarget = players.find(p => p.id === targetPlayerId && p.isAlive);

                if(currentPlayer && currentTarget) {
                    // 交换手牌
                    const temp = currentPlayer.hand;
                    currentPlayer.hand = currentTarget.hand;
                    currentTarget.hand = temp;

                    sendGameLog(`🔄 ${playerName} 与 ${targetPlayerName} 交换了手牌`, 'play');
                    updateGame(msg + ` 与 ${targetPlayerName} 交换手牌`);

                    // 更新双方手牌
                    io.to(playerId).emit('handUpdate', currentPlayer.hand);
                    io.to(targetPlayerId).emit('handUpdate', currentTarget.hand);
                } else {
                    sendGameLog(`🔄 ${playerName} 交换失败（目标已死亡）`, 'play');
                    updateGame(msg);
                }
            };

            // 启动否定窗口
            startNopeWindow({
                type: 'swap',
                playerId: p.id,
                playerName: p.name,
                data: { targetId: targetPlayerId, targetName: targetPlayerName },
                executeCallback
            });
        }
        else if(card.type === CARD_TYPES.NOPE) {
            // 否定卡只能通过 playNope 事件使用（回合外使用）
            // 不应该在这里被触发
            socket.emit('gameLog', { message: '否定卡应该在有可否定动作时使用！', type: 'error' });
            // 退还卡牌
            p.hand.push(card);
            updateGame(msg);
        }
        else if(card.type === CARD_TYPES.DRAW_BOTTOM) {
            // 抽底：从牌堆底部抽一张牌，作为摸牌行为，结束回合
            const playerId = socket.id;
            const playerName = p.name;

            // 创建执行回调
            const executeCallback = () => {
                sendGameLog(`⬇️ ${playerName} 使用抽底卡（作为摸牌）`, 'play');

                if(deck.length === 0) {
                    sendGameLog(`牌堆已空，无法抽牌`, 'info');
                    nextTurn();
                    return;
                }

                // 从牌堆底部（数组开头）抽一张牌
                const bottomCard = deck.shift();

                // 广播抽到的牌
                io.emit('cardPlayed', {
                    cardType: bottomCard.type,
                    playerName: `${playerName} 从底部抽到`,
                    playerId: playerId
                });

                const currentPlayer = players.find(p => p.id === playerId);
                if(!currentPlayer) {
                    nextTurn();
                    return;
                }

                if(bottomCard.type === CARD_TYPES.BOMB) {
                    const defuseIdx = currentPlayer.hand.findIndex(c => c.type === CARD_TYPES.DEFUSE);

                    if(defuseIdx !== -1) {
                        currentPlayer.hand.splice(defuseIdx, 1);
                        discardPile.push({type: CARD_TYPES.DEFUSE});
                        gameStatus = 'defusing';
                        defusingPlayerId = playerId;
                        sendGameLog(`💥 ${playerName} 从底部摸到了炸弹！使用拆除卡拆除`, 'defuse');
                        updateGame(`💥 ${playerName} 从底部摸到了炸弹！使用拆除卡！`);
                        io.to(playerId).emit('askBombPosition', deck.length);
                    } else {
                        currentPlayer.isAlive = false;
                        discardPile.push(bottomCard);
                        sendGameLog(`☠️ ${playerName} 从底部抽到炸弹被炸飞了！`, 'bomb');
                        updateGame(`☠️ ${playerName} 从底部抽到炸弹被炸飞了！`);
                        nextTurn();
                    }
                } else {
                    currentPlayer.hand.push(bottomCard);
                    sendGameLog(`${playerName} 从底部摸了一张牌（作为摸牌，结束出牌阶段）`, 'draw');
                    nextTurn();
                }
            };

            // 启动否定窗口
            startNopeWindow({
                type: 'draw_bottom',
                playerId: p.id,
                playerName: p.name,
                data: {},
                executeCallback
            });
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

        // 验证双方都还存活
        if(!giver.isAlive || !receiver.isAlive) {
            socket.emit('gameLog', { message: '玩家已死亡，无法交换卡牌！', type: 'error' });
            return;
        }

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

    socket.on('playNope', (data) => {
        // 否定卡：可以在任何时候打出（回合外使用）
        const p = players.find(p => p.id === socket.id);
        if(!p || !p.isAlive) return;

        const cardIndex = data.cardIndex;
        const card = p.hand[cardIndex];

        if(!card || card.type !== CARD_TYPES.NOPE) return;

        // 检查是否有待否定的动作
        if(!pendingAction) {
            socket.emit('gameLog', { message: '当前没有可以否定的动作！', type: 'error' });
            return;
        }

        // 检查是否是自己的动作 - 不能否定自己
        if(pendingAction.playerId === socket.id) {
            socket.emit('gameLog', { message: '不能否定自己的动作！', type: 'error' });
            return;
        }

        // 打出否定卡
        p.hand.splice(cardIndex, 1);
        discardPile.push(card);
        io.to(p.id).emit('handUpdate', p.hand);

        // 添加到否定链
        nopeChain.push({ playerId: p.id, playerName: p.name });
        sendGameLog(`🚫 ${p.name} 使用否定卡！(否定链: ${nopeChain.length})`, 'nope');

        // 重置定时器，再给其他人时间否定这个否定
        if(nopeWindow) {
            clearTimeout(nopeWindow);
        }

        nopeWindow = setTimeout(() => {
            executeOrCancelAction();
        }, NOPE_WAIT_TIME);

        // 广播否定事件
        io.emit('nopePlayed', {
            playerName: p.name,
            nopeCount: nopeChain.length,
            waitTime: NOPE_WAIT_TIME
        });
    });

    socket.on('disconnect', () => {
        const player = players.find(p => p.id === socket.id);
        if(player) {
            sendGameLog(`${player.name} 离开了项目`, 'leave');
        }
        players = players.filter(p => p.id !== socket.id);
        if(players.length===0) { gameStatus='lobby'; players=[]; }
        io.emit('playerList', players);
    });
});

const PORT = 3004;
server.listen(PORT, () => console.log(`Listening on ${PORT}`));