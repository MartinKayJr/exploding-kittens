const socket = io();
let myHand = [];
let isMyTurn = false;
let selectedCardIndex = -1; // 当前选中的牌索引，-1表示未选中
let currentPlayers = []; // 存储当前游戏中的玩家列表

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
    else if(cardType === '抽卡') cardName = '索要';
    else if(cardType === '否定') cardName = '交换';

    title.innerText = `使用${cardName}：选择目标对手`;
    container.innerHTML = '';

    // 使用已保存的玩家列表
    currentPlayers.forEach(p => {
        if(p.id !== socket.id && p.isAlive) {
            const btn = document.createElement('button');
            btn.className = 'target-player-btn';
            if(p.attackCount > 0) btn.classList.add('has-attack');

            let badge = '';
            if(p.attackCount > 0) badge = ` 🍳x${p.attackCount}`;

            btn.innerText = `${p.name}${badge} (${p.cardCount}张牌)`;
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