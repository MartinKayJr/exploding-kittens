const socket = io();
let myHand = [];
let isMyTurn = false;
let selectedCardIndex = -1; // 当前选中的牌索引，-1表示未选中
let currentPlayers = []; // 存储当前游戏中的玩家列表

// 否定卡状态
let nopeWindowActive = false;
let nopeCountdownTimer = null;
let nopeCountdown = 0;
let lastActionPlayerName = null; // 记录出牌者的名字

// --- 日志系统 ---
function toggleGameLog() {
    const panel = document.getElementById('game-log-panel');
    panel.classList.toggle('minimized');
}

function addGameLog(message, type = 'info') {
    const logContent = document.getElementById('game-log-content');
    if (!logContent) return;

    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;

    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    entry.innerHTML = `<span class="log-time">${time}</span>${message}`;

    logContent.appendChild(entry);

    // 自动滚动到底部
    logContent.scrollTop = logContent.scrollHeight;

    // 限制日志条目数量（最多保留100条）
    while (logContent.children.length > 100) {
        logContent.removeChild(logContent.firstChild);
    }
}

// 监听游戏日志事件
socket.on('gameLog', (data) => {
    addGameLog(data.message, data.type || 'info');
});

// --- 登录 ---
let hasJoined = false; // 标记是否已加入

function joinGame() {
    const name = document.getElementById('username').value;
    if(name && !hasJoined) {
        socket.emit('join', name);
        hasJoined = true;
        // 隐藏输入框和加入按钮
        document.getElementById('username').style.display = 'none';
        document.querySelector('#lobby .panel button:first-of-type').style.display = 'none';
        document.getElementById('lobby-status').innerHTML = '<h3>等待房主开始...</h3>';
    }
}
function startGame() { socket.emit('start'); }

socket.on('playerList', (players) => {
    const list = document.getElementById('player-list');
    if(list) list.innerHTML = players.map(p => `<li>${p.name} ${p.isHost?'👑':''}</li>`).join('');
    const me = players.find(p => p.id === socket.id);
    if(me && me.isHost && players.length>=2) document.getElementById('start-btn').style.display='inline-block';
});

// --- 游戏渲染 ---
socket.on('gameState', (state) => {
    if(state.gameStatus === 'lobby') return;
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game-ui').style.display = 'flex';
    document.getElementById('bomb-modal').style.display = 'none';

    // 保存当前玩家列表
    currentPlayers = state.players;

    // 状态
    document.getElementById('status-text').innerText = state.log;
    isMyTurn = state.currentPlayerId === socket.id;
    document.getElementById('turn-info').innerText = isMyTurn
        ? `👉 轮到你了！(需摸 ${state.turnsLeft} 次)`
        : `等待对手...`;

    // 1. 渲染 3D 摸牌堆 (核心改进)
    renderDrawPile(state.deckCount, state.bombsInDeck || 0);

    // 2. 渲染 3D 弃牌堆
    renderDiscardPile(state.discardPileTop);

    // 3. 渲染对手
    renderOpponents(state.players, state.currentPlayerId);

    // 4. 高亮当前状态
    if(isMyTurn) document.body.style.boxShadow = "inset 0 0 30px #f1c40f";
    else document.body.style.boxShadow = "none";
});

socket.on('handUpdate', (hand) => {
    myHand = hand;
    selectedCardIndex = -1; // 手牌更新时重置选中状态
    renderHand();
    updatePlayButton();
});

// --- 核心：3D 堆叠算法 ---
function renderDrawPile(count, bombsInDeck = 0) {
    const container = document.getElementById('draw-pile-3d');
    container.innerHTML = ''; // 清空

    // 更新牌数显示
    document.getElementById('card-count').innerText = count;

    // 计算并显示炸弹概率
    if(count > 0 && bombsInDeck > 0) {
        const probability = ((bombsInDeck / count) * 100).toFixed(1);
        document.getElementById('bomb-prob').innerText = probability + '%';
    } else {
        document.getElementById('bomb-prob').innerText = '0%';
    }

    if(count === 0) return;

    // 为了性能和视觉，最多只渲染 30 层
    const visualCount = Math.min(count, 30);

    for(let i = 0; i < visualCount; i++) {
        const card = document.createElement('div');
        card.className = 'card-3d card-back draw-pile-card';

        // 等轴测视图：使用标准等轴测角度
        const offsetZ = i * 3.5; // Z轴厚度堆叠，增加间距让轮廓清晰

        card.style.transform = `
            rotateX(30deg)
            rotateY(-45deg)
            translateZ(${offsetZ}px)
        `;
        card.style.zIndex = i;

        container.appendChild(card);
    }
}

function renderDiscardPile(topCard) {
    const container = document.getElementById('discard-pile-3d');
    if(!topCard) {
        container.innerHTML = '<div class="card discard-placeholder">弃牌堆</div>';
        return;
    }

    // 只渲染这一张最上面的牌
    container.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'card-3d';
    el.setAttribute('data-type', topCard.type);
    // 图片会通过CSS background-image显示，不需要文字

    // 稍微旋转
    el.style.transform = `rotate(${Math.random()*10 - 5}deg)`;

    container.appendChild(el);
}

function renderOpponents(players, currentId) {
    const div = document.getElementById('opponents');
    div.innerHTML = '';
    players.forEach(p => {
        if(p.id === socket.id) return;
        const el = document.createElement('div');
        el.className = `opponent ${p.id === currentId ? 'active' : ''} ${!p.isAlive?'dead':''}`;

        let attackBadge = '';
        if(p.attackCount > 0) {
            attackBadge = ` <span style="background:#e74c3c; padding:2px 6px; border-radius:3px; font-size:10px;">🍳x${p.attackCount}</span>`;
        }

        el.innerHTML = `<div>${p.name}${attackBadge}</div><div style="font-size:12px">🎴 ${p.cardCount}</div>`;
        div.appendChild(el);
    });
}

function renderHand() {
    const div = document.getElementById('my-hand');
    div.innerHTML = '';
    myHand.forEach((c, idx) => {
        const el = document.createElement('div');
        el.className = 'hand-card';
        el.setAttribute('data-type', c.type);
        // 不再显示文字，图片会通过CSS background-image显示

        // 如果是当前选中的牌，添加selected类
        if(idx === selectedCardIndex) {
            el.classList.add('selected');
        }

        // 点击逻辑改为选择/取消选择
        el.onclick = () => {
            if(isMyTurn && c.type !== '炸弹' && c.type !== '拆除') {
                if(selectedCardIndex === idx) {
                    // 取消选择
                    selectedCardIndex = -1;
                } else {
                    // 选择这张牌
                    selectedCardIndex = idx;
                }
                renderHand(); // 重新渲染手牌以更新选中状态
                updatePlayButton(); // 更新出牌按钮显示状态
            }
        };
        div.appendChild(el);
    });
}

// 更新出牌按钮的显示状态
function updatePlayButton() {
    const btn = document.getElementById('play-card-btn');
    if(selectedCardIndex >= 0 && isMyTurn) {
        btn.style.display = 'inline-block';
    } else {
        btn.style.display = 'none';
    }
}

// 出牌函数
function playSelectedCard() {
    if(selectedCardIndex >= 0 && isMyTurn) {
        socket.emit('play', { index: selectedCardIndex });
        selectedCardIndex = -1; // 重置选择
        updatePlayButton();
    }
}

// 当前待选择目标的卡牌信息
let pendingCard = null;

// 监听选择目标事件
socket.on('selectTarget', (data) => {
    pendingCard = data;
    showTargetSelectModal(data.cardType);
});

// 显示目标选择弹窗
function showTargetSelectModal(cardType) {
    const modal = document.getElementById('target-select-modal');
    const title = document.getElementById('target-select-title');
    const container = document.getElementById('target-players');

    let cardName = cardType;
    if(cardType === '攻击') cardName = '甩锅';
    else if(cardType === '索要') cardName = '索要';
    else if(cardType === '交换') cardName = '交换';

    // 甩锅卡允许选择自己
    const isAttackCard = (cardType === '攻击' || cardType === '甩锅x2');
    const titleText = isAttackCard ? `使用${cardName}：选择目标` : `使用${cardName}：选择目标对手`;
    title.innerText = titleText;
    container.innerHTML = '';

    // 使用已保存的玩家列表
    currentPlayers.forEach(p => {
        // 甩锅卡可以选择自己，其他卡不行
        const canSelect = isAttackCard ? p.isAlive : (p.id !== socket.id && p.isAlive);

        if(canSelect) {
            const btn = document.createElement('button');
            btn.className = 'target-player-btn';
            if(p.attackCount > 0) btn.classList.add('has-attack');

            let badge = '';
            if(p.attackCount > 0) badge = ` 🍳x${p.attackCount}`;

            const nameLabel = p.id === socket.id ? `${p.name} (自己)` : p.name;

            btn.innerText = `${nameLabel}${badge} (${p.cardCount}张牌)`;
            btn.onclick = () => selectTargetPlayer(p.id);
            container.appendChild(btn);
        }
    });

    modal.style.display = 'flex';
}

// 选择目标玩家
function selectTargetPlayer(targetId) {
    document.getElementById('target-select-modal').style.display = 'none';

    if(pendingCard) {
        socket.emit('play', {
            index: pendingCard.cardIndex,
            targetId: targetId
        });
        pendingCard = null;
        selectedCardIndex = -1;
        updatePlayButton();
    }
}

// 监听被索要事件
socket.on('giveCard', (data) => {
    showGiveCardModal(data.requesterName, data.requesterId);
});

// 显示给牌弹窗
function showGiveCardModal(requesterName, requesterId) {
    const modal = document.getElementById('give-card-modal');
    const title = document.getElementById('give-card-title');
    const container = document.getElementById('give-card-hand');

    title.innerText = `${requesterName} 向你索要一张牌`;
    container.innerHTML = '';

    myHand.forEach((card, idx) => {
        const el = document.createElement('div');
        el.className = 'give-card-item';
        el.setAttribute('data-type', card.type);
        el.onclick = () => giveCardToPlayer(idx, requesterId);
        container.appendChild(el);
    });

    modal.style.display = 'flex';
}

// 给出一张牌
function giveCardToPlayer(cardIndex, requesterId) {
    document.getElementById('give-card-modal').style.display = 'none';
    socket.emit('giveCardResponse', {
        cardIndex: cardIndex,
        requesterId: requesterId
    });
}

// --- 动作与弹窗 ---
function drawCard() {
    if(isMyTurn) socket.emit('draw');
}

// 埋雷相关
socket.on('askBombPosition', (deckSize) => {
    document.getElementById('bomb-modal').style.display = 'flex';
});

function confirmBomb(position) {
    // position: 0=牌顶, 1=第二张, 2=第三张, -1=牌底
    document.getElementById('bomb-modal').style.display = 'none';
    socket.emit('insertBomb', position);
}

// 预言（文字提示）
socket.on('showFutureText', (text) => {
    document.getElementById('future-text-content').innerText = text;
    document.getElementById('future-text-modal').style.display = 'flex';
});

// 透视（显示三张牌）
socket.on('showFuture', (cards) => {
    const div = document.getElementById('future-cards');
    div.innerHTML = cards.map(c => `
        <div class="hand-card" data-type="${c.type}" style="display:inline-flex; margin:5px;"></div>
    `).join('');
    document.getElementById('future-modal').style.display = 'flex';
});

socket.on('gameOver', (winner) => {
    alert(`🎉 游戏结束！获胜者: ${winner}`);
    location.reload();
});

// --- 否定窗口相关 ---

// 显示否定窗口
function showNopeWindow(actionInfo, waitTime) {
    nopeWindowActive = true;
    nopeCountdown = waitTime / 1000;

    const modal = document.getElementById('nope-window-modal');
    const btn = document.getElementById('nope-btn');
    const actionInfoEl = document.getElementById('nope-action-info');

    // 更新动作信息显示
    if (actionInfo) {
        const { cardName, playerName, targetName, isSelfTarget } = actionInfo;
        let infoHtml = '';

        if (targetName) {
            if (isSelfTarget) {
                infoHtml = `<strong style="color: #3498db;">${playerName}</strong> 对 <strong style="color: #e67e22;">自己</strong> 使用了 <strong style="color: #e74c3c;">${cardName}</strong>`;
            } else {
                infoHtml = `<strong style="color: #3498db;">${playerName}</strong> 对 <strong style="color: #e67e22;">${targetName}</strong> 使用了 <strong style="color: #e74c3c;">${cardName}</strong>`;
            }
        } else {
            infoHtml = `<strong style="color: #3498db;">${playerName}</strong> 使用了 <strong style="color: #e74c3c;">${cardName}</strong>`;
        }

        actionInfoEl.innerHTML = infoHtml;
    }

    // 检查是否是自己出的牌
    const myPlayer = currentPlayers.find(p => p.id === socket.id);
    const isMyAction = myPlayer && lastActionPlayerName === myPlayer.name;

    // 如果是自己出的牌，不显示否定按钮
    if (isMyAction) {
        btn.style.display = 'none';
        btn.disabled = true;
        addGameLog('你不能否定自己的行动', 'info');
    } else {
        // 检查是否有否定卡
        const hasNopeCard = myHand.some(card => card.type === '否定');
        if (hasNopeCard) {
            btn.style.display = 'inline-block';
            btn.disabled = false;
        } else {
            btn.style.display = 'none';
            btn.disabled = true;
        }
    }

    modal.style.display = 'flex';

    // 启动倒计时
    updateNopeCountdown();
    nopeCountdownTimer = setInterval(() => {
        nopeCountdown -= 0.1;
        if (nopeCountdown <= 0 || !nopeWindowActive) {
            clearInterval(nopeCountdownTimer);
            nopeCountdownTimer = null;
        } else {
            updateNopeCountdown();
        }
    }, 100);
}

// 更新否定窗口倒计时显示
function updateNopeCountdown() {
    const countdownEl = document.getElementById('nope-countdown');
    if (countdownEl) {
        countdownEl.innerText = nopeCountdown.toFixed(1) + 's';

        // 根据剩余时间改变颜色
        if (nopeCountdown < 1) {
            countdownEl.style.color = '#e74c3c'; // 红色
        } else if (nopeCountdown < 2) {
            countdownEl.style.color = '#f39c12'; // 橙色
        } else {
            countdownEl.style.color = '#2ecc71'; // 绿色
        }
    }
}

// 隐藏否定窗口
function hideNopeWindow() {
    nopeWindowActive = false;
    if (nopeCountdownTimer) {
        clearInterval(nopeCountdownTimer);
        nopeCountdownTimer = null;
    }
    document.getElementById('nope-window-modal').style.display = 'none';
}

// 使用否定卡
function playNopeCard() {
    // 检查是否是自己出的牌
    const myPlayer = currentPlayers.find(p => p.id === socket.id);
    const isMyAction = myPlayer && lastActionPlayerName === myPlayer.name;

    if (isMyAction) {
        addGameLog('你不能否定自己的行动！', 'error');
        return;
    }

    const nopeCardIndex = myHand.findIndex(card => card.type === '否定');
    if (nopeCardIndex === -1) {
        addGameLog('你没有否定卡！', 'error');
        return;
    }

    socket.emit('playNope', { cardIndex: nopeCardIndex });
    addGameLog('使用否定卡...', 'nope');
}

// Socket 事件：否定窗口开始
socket.on('nopeWindowStart', (data) => {
    lastActionPlayerName = data.playerName; // 保存出牌者名字

    // 构建详细的日志消息
    let logMsg = `${data.playerName} 使用了 ${data.cardName || data.action}`;
    if (data.targetName) {
        if (data.isSelfTarget) {
            logMsg += ` 对自己`;
        } else {
            logMsg += ` 对 ${data.targetName}`;
        }
    }
    logMsg += '，等待否定...';
    addGameLog(logMsg, 'nope');

    // 传递动作详细信息
    showNopeWindow({
        cardName: data.cardName || data.action,
        playerName: data.playerName,
        targetName: data.targetName,
        isSelfTarget: data.isSelfTarget
    }, data.waitTime);
});

// Socket 事件：有人使用了否定卡
socket.on('nopePlayed', (data) => {
    const chainCountEl = document.getElementById('nope-chain-count');
    if (chainCountEl) {
        chainCountEl.innerText = data.nopeCount;
    }

    // 重置倒计时
    nopeCountdown = data.waitTime / 1000;

    addGameLog(`${data.playerName} 使用否定卡！(否定链: ${data.nopeCount})`, 'nope');

    // 更新否定按钮显示（可能用掉了否定卡）
    const myPlayer = currentPlayers.find(p => p.id === socket.id);
    const isMyAction = myPlayer && lastActionPlayerName === myPlayer.name;

    const hasNopeCard = myHand.some(card => card.type === '否定');
    const btn = document.getElementById('nope-btn');
    if (btn) {
        // 如果是自己的行动，不显示否定按钮
        if (isMyAction) {
            btn.style.display = 'none';
            btn.disabled = true;
        } else {
            btn.style.display = hasNopeCard ? 'inline-block' : 'none';
            btn.disabled = !hasNopeCard;
        }
    }
});

// Socket 事件：否定窗口结束
socket.on('nopeWindowEnd', (data) => {
    hideNopeWindow();
    lastActionPlayerName = null; // 清空出牌者信息

    if (data.isCancelled) {
        addGameLog(`动作被否定！(否定次数: ${data.nopedCount})`, 'nope');
    } else if (data.nopedCount > 0) {
        addGameLog(`否定被否定！动作继续执行 (否定次数: ${data.nopedCount})`, 'nope');
    }
});

// 键盘快捷键
document.addEventListener('keydown', (e) => {
    // N 键 - 使用否定卡
    if ((e.key === 'n' || e.key === 'N') && nopeWindowActive) {
        playNopeCard();
    }
});