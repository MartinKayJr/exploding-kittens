#!/usr/bin/env node
// -*- coding: utf-8 -*-

// 强制设置 UTF-8 编码
process.stdout.setDefaultEncoding('utf8');
if (process.stderr) {
    process.stderr.setDefaultEncoding('utf8');
}

// 设置环境变量
process.env.LANG = 'zh_CN.UTF-8';
process.env.LC_ALL = 'zh_CN.UTF-8';

// Windows 平台额外设置
if (process.platform === 'win32') {
    const { execSync } = require('child_process');
    try {
        execSync('chcp 65001', { stdio: 'ignore' });
    } catch (e) {
        // 忽略错误
    }
}

const blessed = require('blessed');
const io = require('socket.io-client');

// === 配置 ===
function parseServerAddress() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        return 'http://localhost:3004';
    }
    let serverAddr = args[0];
    if (!serverAddr.startsWith('http://') && !serverAddr.startsWith('https://')) {
        serverAddr = 'http://' + serverAddr;
    }
    return serverAddr;
}

const SERVER_URL = parseServerAddress();

// === 全局状态 ===
let socket = null;
let myHand = [];
let players = [];
let gameState = null;
let myName = '';
let isMyTurn = false;
let currentPlayers = [];
let pendingRequesterId = null;
let lastPlayedCard = null;
let lastPlayedBy = null;
let isHost = false;

// 场景状态
let currentScene = 'login'; // login, lobby, game
let gameSubScene = 'main'; // main, selectCard, selectTarget, selectBombPos, giveCard, info

// 否定卡状态
let nopeWindowActive = false;
let nopeCountdown = 0;
let nopeChainCount = 0;

// === 创建屏幕 ===
const screen = blessed.screen({
    smartCSR: true,
    title: '爆炸猫',
    fullUnicode: true,
    forceUnicode: true,
    dockBorders: true
});

// === 卡牌名称映射 ===
const CARD_NAMES = {
    '炸弹': '炸弹',
    '拆除': '拆除',
    '攻击': '甩锅',
    '甩锅x2': '甩锅x2',
    '跳过': '跳过',
    '预言': '预言',
    '透视': '透视',
    '洗牌': '洗牌',
    '索要': '索要',
    '抽底': '抽底',
    '交换': '交换',
    '否定': '否定'
};

const CARD_SYMBOLS = {
    '炸弹': '💣',
    '拆除': '🛡',
    '攻击': '🍳',
    '甩锅x2': '🍳🍳',
    '跳过': '⏭',
    '预言': '🔮',
    '透视': '👁',
    '洗牌': '🔀',
    '索要': '🎯',
    '抽底': '⬇️',
    '交换': '🔄',
    '否定': '🚫'
};

function getCardName(cardType) {
    return CARD_NAMES[cardType] || cardType;
}

function getCardSymbol(cardType) {
    return CARD_SYMBOLS[cardType] || '?';
}

// ========== 场景：登录界面 ==========
const loginScene = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    hidden: false
});

const loginTitle = blessed.box({
    top: '20%',
    left: 'center',
    width: '80%',
    height: 3,
    content: '{center}{bold}🎮 爆炸猫 Exploding Kittens 🎮{/bold}{/center}',
    tags: true,
    style: {
        fg: 'cyan'
    }
});

const serverInfo = blessed.box({
    top: '25%',
    left: 'center',
    width: '80%',
    height: 3,
    content: `{center}服务器: ${SERVER_URL}{/center}`,
    tags: true,
    style: {
        fg: 'gray'
    }
});

const namePrompt = blessed.box({
    top: '35%',
    left: 'center',
    width: '80%',
    height: 3,
    content: '{center}{bold}请在下方输入框中输入你的名字，然后按 Enter{/bold}{/center}',
    tags: true,
    style: {
        fg: 'white'
    }
});

const loginStatus = blessed.box({
    top: '45%',
    left: 'center',
    width: '80%',
    height: 3,
    content: '{center}{gray-fg}支持中文、英文、数字 | 按 Ctrl+C 退出{/gray-fg}{/center}',
    tags: true,
    style: {
        fg: 'gray'
    }
});

// 底部输入区域
const nameInputArea = blessed.textarea({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    border: {
        type: 'line'
    },
    label: ' 输入你的名字 ',
    style: {
        fg: 'cyan',
        bg: 'black',
        border: {
            fg: 'cyan'
        },
        focus: {
            border: {
                fg: 'white'
            }
        }
    },
    keys: true,
    mouse: true,
    inputOnFocus: true
});

loginScene.append(loginTitle);
loginScene.append(serverInfo);
loginScene.append(namePrompt);
loginScene.append(loginStatus);
loginScene.append(nameInputArea);

// ========== 场景：等待大厅 ==========
const lobbyScene = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    hidden: true
});

const lobbyTitle = blessed.box({
    top: 2,
    left: 'center',
    width: '80%',
    height: 3,
    content: '{center}{bold}等待其他玩家加入...{/bold}{/center}',
    tags: true,
    style: {
        fg: 'cyan'
    }
});

const lobbyPlayerList = blessed.box({
    top: 6,
    left: 'center',
    width: '60%',
    height: '50%',
    label: ' 已加入的玩家 ',
    border: {
        type: 'line'
    },
    style: {
        border: {
            fg: 'cyan'
        }
    },
    tags: true,
    scrollable: true
});

const startButton = blessed.button({
    bottom: 5,
    left: 'center',
    width: 20,
    height: 3,
    content: '{center}开始项目{/center}',
    tags: true,
    border: {
        type: 'line'
    },
    style: {
        fg: 'black',
        bg: 'green',
        border: {
            fg: 'green'
        },
        focus: {
            bg: 'white',
            fg: 'black'
        }
    }
});

const lobbyStatus = blessed.box({
    bottom: 1,
    left: 'center',
    width: '80%',
    height: 1,
    content: '{center}等待房主开始项目...{/center}',
    tags: true,
    style: {
        fg: 'gray'
    }
});

lobbyScene.append(lobbyTitle);
lobbyScene.append(lobbyPlayerList);
lobbyScene.append(startButton);
lobbyScene.append(lobbyStatus);

// ========== 场景：项目界面 ==========
const gameScene = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    hidden: true
});

// 顶部标题栏
const gameTitle = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: '{center}爆炸猫{/center}',
    tags: true,
    style: {
        fg: 'white',
        bg: 'black',
        bold: true
    }
});

// 左侧：炸弹概率（扩大显示）
const bombRateBox = blessed.box({
    top: 3,
    left: 0,
    width: '25%',
    height: '40%',
    label: ' 概率 ',
    border: {
        type: 'line'
    },
    style: {
        fg: 'white',
        border: {
            fg: 'cyan'
        }
    },
    tags: true,
    content: '{center}\n\n{green-fg}安全{/green-fg}\n{bold}0.0%{/bold}{/center}'
});

// 中间：出牌区
const playArea = blessed.box({
    top: 3,
    left: '25%',
    width: '50%',
    height: '40%',
    label: ' 桌面 ',
    border: {
        type: 'line'
    },
    style: {
        fg: 'white',
        border: {
            fg: 'gray'
        }
    },
    tags: true,
    scrollable: true
});

// 右侧：玩家列表
const playerBox = blessed.box({
    top: 3,
    left: '75%',
    width: '25%',
    height: '40%',
    label: ' 玩家 ',
    border: {
        type: 'line'
    },
    style: {
        fg: 'white',
        border: {
            fg: 'gray'
        }
    },
    tags: true,
    scrollable: true
});

// 项目日志
const gameLog = blessed.log({
    top: '43%',
    left: 0,
    width: '100%',
    height: '30%',
    label: ' 项目日志 ',
    border: {
        type: 'line'
    },
    style: {
        fg: 'white',
        border: {
            fg: 'gray'
        }
    },
    tags: true,
    scrollable: true,
    scrollbar: {
        ch: '█',
        style: {
            fg: 'gray'
        }
    }
});

// 底部操作提示
const actionHint = blessed.box({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    border: {
        type: 'line'
    },
    style: {
        fg: 'white',
        border: {
            fg: 'gray'
        }
    },
    tags: true,
    content: '{center}等待你的回合...{/center}'
});

// 否定窗口提示框
const nopeWindowBox = blessed.box({
    top: 'center',
    left: 'center',
    width: '60%',
    height: 7,
    border: {
        type: 'line'
    },
    style: {
        fg: 'yellow',
        bg: 'black',
        border: {
            fg: 'yellow'
        }
    },
    tags: true,
    hidden: true,
    content: ''
});

gameScene.append(gameTitle);
gameScene.append(bombRateBox);
gameScene.append(playArea);
gameScene.append(playerBox);
gameScene.append(gameLog);
gameScene.append(actionHint);
gameScene.append(nopeWindowBox);

// ========== 通用选择对话框 ==========
const selectionDialog = blessed.list({
    top: 'center',
    left: 'center',
    width: '50%',
    height: '60%',
    label: ' 选择 ',
    border: {
        type: 'line'
    },
    style: {
        fg: 'white',
        bg: 'black',
        border: {
            fg: 'cyan'
        },
        selected: {
            bg: 'cyan',
            fg: 'black',
            bold: true
        },
        item: {
            fg: 'white'
        }
    },
    hidden: true,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    interactive: true,
    scrollbar: {
        ch: '█',
        style: {
            fg: 'cyan'
        }
    }
});

// ========== 信息对话框 ==========
const infoDialog = blessed.box({
    top: 'center',
    left: 'center',
    width: '70%',
    height: '70%',
    label: ' 信息 ',
    border: {
        type: 'line'
    },
    style: {
        fg: 'white',
        bg: 'black',
        border: {
            fg: 'yellow'
        }
    },
    hidden: true,
    tags: true,
    keys: true,
    scrollable: true,
    scrollbar: {
        ch: '█',
        style: {
            fg: 'yellow'
        }
    },
    content: '',
    padding: {
        left: 2,
        right: 2,
        top: 1,
        bottom: 1
    }
});

// ========== 添加到屏幕 ==========
screen.append(loginScene);
screen.append(lobbyScene);
screen.append(gameScene);
screen.append(selectionDialog);
screen.append(infoDialog);

// ========== 辅助函数 ==========
function addLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    gameLog.log(`[${timestamp}] ${message}`);
    screen.render();
}

function showScene(scene) {
    currentScene = scene;
    loginScene.hide();
    lobbyScene.hide();
    gameScene.hide();

    switch(scene) {
        case 'login':
            loginScene.show();
            nameInputArea.clearValue();
            nameInputArea.focus();
            screen.render();
            setTimeout(() => {
                nameInputArea.readInput();
            }, 100);
            break;
        case 'lobby':
            lobbyScene.show();
            startButton.focus();
            // 如果已经有玩家数据，立即更新显示
            if(currentPlayers.length > 0) {
                updateLobbyPlayerList();
            }
            break;
        case 'game':
            gameScene.show();
            break;
    }
    screen.render();
}

function updateDeckArea() {
    if (!gameState) {
        bombRateBox.setContent('{center}\n\n安全 - 剩0张 - 0.0%{/center}');
        screen.render();
        return;
    }

    const deckCount = gameState.deckCount || 0;
    const bombsInDeck = gameState.bombsInDeck || 0;
    const probability = deckCount > 0 ? ((bombsInDeck / deckCount) * 100).toFixed(1) : '0.0';
    const probNum = parseFloat(probability);

    let rateColor = 'green-fg';
    let rateLabel = '安全';

    if (bombsInDeck === 0) {
        rateColor = 'green-fg';
        rateLabel = '无炸弹';
    } else if (probNum >= 50) {
        rateColor = 'red-fg';
        rateLabel = '危险';
    } else if (probNum >= 25) {
        rateColor = 'yellow-fg';
        rateLabel = '警告';
    } else if (probNum >= 10) {
        rateColor = 'yellow-fg';
        rateLabel = '注意';
    } else if (probNum > 0) {
        rateColor = 'cyan-fg';
        rateLabel = '较低';
    }

    // 简洁的一行显示：状态 - 剩余张数 - 概率
    let rateContent = '\n\n';
    rateContent += `{center}{${rateColor}}{bold}${rateLabel}{/bold}{/${rateColor}} - `;
    rateContent += `剩{bold}${deckCount}{/bold}张 - `;
    rateContent += `{${rateColor}}{bold}${probability}%{/bold}{/${rateColor}}{/center}`;

    bombRateBox.setContent(rateContent);
    screen.render();
}

function updatePlayArea() {
    if (!lastPlayedCard || !lastPlayedBy) {
        playArea.setContent('{center}\n\n\n等待出牌...{/center}');
        screen.render();
        return;
    }

    const cardName = getCardName(lastPlayedCard);
    const symbol = getCardSymbol(lastPlayedCard);

    let content = '\n\n\n';
    content += `{center}{bold}${symbol} ${cardName}{/bold}{/center}\n\n`;
    content += `{center}{gray-fg}${lastPlayedBy}{/gray-fg}{/center}`;

    playArea.setContent(content);
    screen.render();
}

function updatePlayerList() {
    let content = '\n';
    currentPlayers.forEach((p, idx) => {
        const isMe = p.id === (socket ? socket.id : null);
        const isCurrent = gameState && p.id === gameState.currentPlayerId;
        const aliveMark = p.isAlive ? '' : ' [已阵亡]';
        const meMark = isMe ? ' (你)' : '';

        let line = '';
        if (isCurrent) {
            line = `{inverse} ► ${idx + 1}. ${p.name}${meMark}${aliveMark} [${p.cardCount}张] {/inverse}`;
        } else {
            line = `   ${idx + 1}. ${p.name}${meMark}${aliveMark} [${p.cardCount}张]`;
        }

        content += line + '\n';
    });

    playerBox.setContent(content);
    screen.render();
}

function updateGameTitle() {
    let status = '{center}爆炸猫';
    if (myName) {
        status += ` - ${myName}`;
    }
    if (gameState && gameState.gameStatus === 'playing') {
        if (isMyTurn) {
            status += ' {inverse} 你的回合 {/inverse}';
            if (gameState.turnsLeft > 1) {
                status += ` (还需${gameState.turnsLeft}次)`;
            }
        }
    }
    status += '{/center}';
    gameTitle.setContent(status);
    screen.render();
}

function updateActionHint() {
    if (nopeWindowActive) {
        // 否定窗口激活时，检查是否是自己出的牌
        const isMyCard = lastPlayedBy === myName;

        if (isMyCard) {
            // 如果是自己出的牌，不能否定
            actionHint.setContent('{center}{gray-fg}你不能否定自己的行动...{/gray-fg}{/center}');
            actionHint.style.border.fg = 'gray';
        } else {
            // 如果是别人出的牌，检查是否有否定卡
            const hasNopeCard = myHand.some(card => card.type === '否定');
            if (hasNopeCard) {
                actionHint.setContent('{center}{yellow-fg}【N】使用否定卡{/yellow-fg}{/center}');
                actionHint.style.border.fg = 'yellow';
            } else {
                actionHint.setContent('{center}{gray-fg}等待否定窗口结束...{/gray-fg}{/center}');
                actionHint.style.border.fg = 'gray';
            }
        }
    } else if (!isMyTurn) {
        actionHint.setContent('{center}等待你的回合...{/center}');
        actionHint.style.border.fg = 'gray';
    } else {
        actionHint.setContent('{center}{cyan-fg}【空格】出牌  【D】抽牌  【ESC】取消{/cyan-fg}{/center}');
        actionHint.style.border.fg = 'cyan';
    }
    screen.render();
}

function updateLobbyPlayerList() {
    let content = '\n';
    currentPlayers.forEach((p, idx) => {
        const isMe = p.id === (socket ? socket.id : null);
        const hostMark = p.isHost ? ' 👑' : '';
        const meMark = isMe ? ' (你)' : '';
        content += `  ${idx + 1}. ${p.name}${hostMark}${meMark}\n`;
    });
    lobbyPlayerList.setContent(content);

    // 更新状态提示
    if (isHost) {
        lobbyStatus.setContent('{center}{green-fg}你是房主，按 Enter 开始项目{/green-fg}{/center}');
    } else {
        lobbyStatus.setContent('{center}等待房主开始项目...{/center}');
    }

    screen.render();
}

function showCardSelection() {
    // 过滤掉拆除卡和炸弹卡（不能主动出）
    const playableCards = myHand
        .map((card, originalIndex) => ({ card, originalIndex }))
        .filter(item => item.card.type !== '拆除' && item.card.type !== '炸弹');

    if (playableCards.length === 0) {
        addLog('没有可以出的牌（拆除卡和炸弹卡不能主动出）');
        return;
    }

    selectionDialog.clearItems();
    selectionDialog.setLabel(' 选择要出的牌 (↑↓选择, Enter确认, ESC取消) ');

    const items = playableCards.map(item => {
        const symbol = getCardSymbol(item.card.type);
        const name = getCardName(item.card.type);
        return `${symbol} ${name}`;
    });

    selectionDialog.setItems(items);
    selectionDialog.select(0);
    selectionDialog.show();
    selectionDialog.focus();
    screen.render();

    // 确保键盘事件正确绑定
    const handleSelect = (item, index) => {
        selectionDialog.removeListener('select', handleSelect);
        selectionDialog.removeListener('cancel', handleCancel);
        selectionDialog.hide();
        // 使用原始索引，因为我们过滤了某些牌
        const originalIndex = playableCards[index].originalIndex;
        socket.emit('play', { index: originalIndex });
        addLog(`出牌: ${myHand[originalIndex].type}`);
        screen.render();
    };

    const handleCancel = () => {
        selectionDialog.removeListener('select', handleSelect);
        selectionDialog.removeListener('cancel', handleCancel);
        selectionDialog.hide();
        screen.render();
    };

    selectionDialog.once('select', handleSelect);
    selectionDialog.once('cancel', handleCancel);
}

function showPlayerSelection(title, callback, allowSelf = false) {
    // 根据 allowSelf 参数决定是否包含自己
    const alivePlayers = currentPlayers.filter(p => {
        if (allowSelf) {
            return p.isAlive; // 包含所有存活玩家（包括自己）
        } else {
            return p.id !== socket.id && p.isAlive; // 排除自己
        }
    });

    if (alivePlayers.length === 0) {
        addLog('没有可选择的目标');
        return;
    }

    selectionDialog.clearItems();
    selectionDialog.setLabel(` ${title} (↑↓选择, Enter确认, ESC取消) `);

    const items = alivePlayers.map((p) => {
        const isMe = p.id === socket.id;
        const meMark = isMe ? ' (你自己)' : '';
        return `${p.name}${meMark} [${p.cardCount}张]`;
    });

    selectionDialog.setItems(items);
    selectionDialog.select(0);
    selectionDialog.show();
    selectionDialog.focus();
    screen.render();

    selectionDialog.once('select', (item, index) => {
        selectionDialog.hide();
        const selectedPlayer = alivePlayers[index];
        if (callback) callback(selectedPlayer);
        screen.render();
    });

    selectionDialog.once('cancel', () => {
        selectionDialog.hide();
        screen.render();
    });
}

function showBombPositionSelection() {
    selectionDialog.clearItems();
    selectionDialog.setLabel(' 💣 选择炸弹放置位置 (↑↓选择, Enter确认) ');

    const items = [
        '0. 最上面 (下一张) - 最危险！',
        '1. 第二张',
        '2. 第三张',
        '-1. 最下面 - 最安全！'
    ];

    selectionDialog.setItems(items);
    selectionDialog.select(0);
    selectionDialog.show();
    selectionDialog.focus();
    screen.render();

    selectionDialog.once('select', (item, index) => {
        selectionDialog.hide();
        const positions = [0, 1, 2, -1];
        const pos = positions[index];
        socket.emit('insertBomb', pos);
        addLog(`将炸弹放在位置 ${pos}`);
        screen.render();
    });
}

function showInfo(title, content) {
    infoDialog.setLabel(` ${title} (按任意键关闭) `);
    infoDialog.setContent(content);
    infoDialog.show();
    infoDialog.focus();
    screen.render();
}

function showNopeWindow(actionInfo, waitTime) {
    nopeWindowActive = true;
    nopeCountdown = waitTime / 1000;
    nopeChainCount = 0;

    updateNopeWindowDisplay(actionInfo);
    nopeWindowBox.show();
    updateActionHint();
    screen.render();

    // 启动倒计时更新
    const countdownInterval = setInterval(() => {
        nopeCountdown -= 0.1;
        if (nopeCountdown <= 0 || !nopeWindowActive) {
            clearInterval(countdownInterval);
        } else {
            updateNopeWindowDisplay(actionInfo);
        }
    }, 100);
}

function updateNopeWindowDisplay(actionInfo = null) {
    let content = '\n{center}{bold}{yellow-fg}⚠️  否定窗口 ⚠️{/yellow-fg}{/bold}{/center}\n\n';

    // 显示动作详细信息
    if (actionInfo) {
        const { cardName, playerName, targetName, isSelfTarget } = actionInfo;

        if (targetName) {
            if (isSelfTarget) {
                content += `{center}{cyan-fg}{bold}${playerName}{/bold} 对 {bold}自己{/bold} 使用了 {bold}${cardName}{/bold}{/cyan-fg}{/center}\n\n`;
            } else {
                content += `{center}{cyan-fg}{bold}${playerName}{/bold} 对 {bold}${targetName}{/bold} 使用了 {bold}${cardName}{/bold}{/cyan-fg}{/center}\n\n`;
            }
        } else {
            content += `{center}{cyan-fg}{bold}${playerName}{/bold} 使用了 {bold}${cardName}{/bold}{/cyan-fg}{/center}\n\n`;
        }
    }

    content += `{center}倒计时: {bold}${nopeCountdown.toFixed(1)}秒{/bold}{/center}\n`;
    if (nopeChainCount > 0) {
        content += `{center}否定链: {bold}${nopeChainCount}次{/bold}{/center}`;
    }
    nopeWindowBox.setContent(content);
    screen.render();
}

function hideNopeWindow() {
    nopeWindowActive = false;
    nopeWindowBox.hide();
    updateActionHint();
    screen.render();
}

// ========== Socket.IO 连接 ==========
function connectToServer() {
    addLog(`连接服务器: ${SERVER_URL}`);
    socket = io(SERVER_URL);

    socket.on('connect', () => {
        addLog(`已连接到 ${SERVER_URL}`);
    });

    socket.on('disconnect', () => {
        addLog('与服务器断开连接');
    });

    socket.on('nameRejected', (data) => {
        addLog(`名字被拒绝: ${data.reason}`);
        // 显示错误提示
        loginStatus.setContent('{center}{red-fg}该名字已被使用，请换一个！{/red-fg}{/center}');
        screen.render();

        // 确保在登录界面
        if (currentScene !== 'login') {
            showScene('login');
        }

        setTimeout(() => {
            loginStatus.setContent('{center}{gray-fg}支持中文、英文、数字 | 按 Ctrl+C 退出{/gray-fg}{/center}');
            nameInputArea.clearValue();
            nameInputArea.focus();
            screen.render();
        }, 2000);
    });

    socket.on('nameAccepted', () => {
        // 名字被接受，可以进入大厅
        if (currentScene === 'login') {
            showScene('lobby');
        }
    });

    socket.on('playerList', (players) => {
        currentPlayers = players;

        // 检查自己是否是房主
        const me = players.find(p => p.id === socket.id);
        isHost = me ? me.isHost : false;

        if (currentScene === 'lobby') {
            updateLobbyPlayerList();
        } else if (currentScene === 'game') {
            updatePlayerList();
        }
    });

    socket.on('gameState', (state) => {
        gameState = state;
        currentPlayers = state.players;
        const wasMyTurn = isMyTurn;
        isMyTurn = state.currentPlayerId === socket.id;

        if (currentScene !== 'game') {
            showScene('game');
        }

        updatePlayerList();
        updateDeckArea();
        updateGameTitle();
        updateActionHint();

        if (isMyTurn && !wasMyTurn) {
            addLog('轮到你了！按空格出牌，或按D抽牌');
        }
    });

    socket.on('handUpdate', (hand) => {
        myHand = hand;
        // 更新操作提示（可能获得或失去否定卡）
        if (nopeWindowActive) {
            updateActionHint();
        }
    });

    socket.on('gameLog', (data) => {
        addLog(data.message);
    });

    socket.on('gameOver', (winner) => {
        addLog(`项目结束！胜者: ${winner}`);
        lastPlayedCard = null;
        lastPlayedBy = null;
        updatePlayArea();
    });

    socket.on('selectTarget', (data) => {
        const cardName = getCardName(data.cardType);
        addLog(`请选择 ${cardName} 的目标`);

        // 甩锅卡允许选择自己，其他卡不允许
        const isAttackCard = data.cardType === '攻击' || data.cardType === '甩锅x2';
        const allowSelf = isAttackCard;

        showPlayerSelection(`选择${cardName}的目标`, (selectedPlayer) => {
            socket.emit('play', {
                index: data.cardIndex,
                targetId: selectedPlayer.id
            });
            const targetName = selectedPlayer.id === socket.id ? '自己' : selectedPlayer.name;
            addLog(`对 ${targetName} 使用 ${cardName}`);
        }, allowSelf);
    });

    socket.on('showFutureText', (text) => {
        let content = '\n{center}{bold}🔮 预言{/bold}{/center}\n\n';
        content += `{center}${text}{/center}\n\n`;
        content += '{center}{gray-fg}按任意键关闭{/gray-fg}{/center}';
        showInfo('🔮 预言', content);
        addLog(text);
    });

    socket.on('showFuture', (cards) => {
        let content = '\n{center}{bold}👁 透视 - 牌堆顶部3张{/bold}{/center}\n\n';

        if (cards.length === 0) {
            content += '{center}牌堆没有牌{/center}\n';
        } else {
            cards.forEach((card, idx) => {
                const symbol = getCardSymbol(card.type);
                const name = getCardName(card.type);
                content += `{center}${idx + 1}. ${symbol} {bold}${name}{/bold}{/center}\n`;
            });
        }

        content += '\n{center}{gray-fg}按任意键关闭{/gray-fg}{/center}';
        showInfo('👁 透视', content);
        addLog('使用透视查看了牌堆顶部3张牌');
    });

    socket.on('askBombPosition', () => {
        addLog('拆除炸弹！选择放回的位置');
        showBombPositionSelection();
    });

    socket.on('giveCard', (data) => {
        addLog(`${data.requesterName} 向你索要一张牌`);

        selectionDialog.clearItems();
        selectionDialog.setLabel(` 给 ${data.requesterName} 一张牌 (↑↓选择, Enter确认) `);

        const items = myHand.map((card) => {
            const symbol = getCardSymbol(card.type);
            const name = getCardName(card.type);
            return `${symbol} ${name}`;
        });

        selectionDialog.setItems(items);
        selectionDialog.select(0);
        selectionDialog.show();
        selectionDialog.focus();
        screen.render();

        selectionDialog.once('select', (item, index) => {
            selectionDialog.hide();
            socket.emit('giveCardResponse', {
                cardIndex: index,
                requesterId: data.requesterId
            });
            const cardName = getCardName(myHand[index].type);
            addLog(`给了 ${data.requesterName} ${cardName}`);
            screen.render();
        });
    });

    socket.on('cardPlayed', (data) => {
        lastPlayedCard = data.cardType;
        lastPlayedBy = data.playerName;
        updatePlayArea();
    });

    socket.on('nopeWindowStart', (data) => {
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
        addLog(logMsg);

        // 传递动作详细信息
        showNopeWindow({
            cardName: data.cardName || data.action,
            playerName: data.playerName,
            targetName: data.targetName,
            isSelfTarget: data.isSelfTarget
        }, data.waitTime);
    });

    socket.on('nopePlayed', (data) => {
        nopeChainCount = data.nopeCount;
        nopeCountdown = data.waitTime / 1000; // 重置倒计时
        updateNopeWindowDisplay();
        addLog(`${data.playerName} 使用否定卡！(否定链: ${data.nopeCount})`);
    });

    socket.on('nopeWindowEnd', (data) => {
        hideNopeWindow();
        if (data.isCancelled) {
            addLog(`动作被否定！(否定次数: ${data.nopedCount})`);
        } else if (data.nopedCount > 0) {
            addLog(`否定被否定！动作继续执行 (否定次数: ${data.nopedCount})`);
        }
    });
}

// ========== 键盘事件 ==========

// 登录场景 - Enter 键提交
nameInputArea.key(['enter'], () => {
    if (currentScene !== 'login') return;

    const name = (nameInputArea.getValue() || '').trim();

    if (!name) {
        loginStatus.setContent('{center}{red-fg}请输入名字！{/red-fg}{/center}');
        screen.render();

        setTimeout(() => {
            loginStatus.setContent('{center}{gray-fg}支持中文、英文、数字 | 按 Ctrl+C 退出{/gray-fg}{/center}');
            nameInputArea.clearValue();
            nameInputArea.focus();
            screen.render();
        }, 1500);
        return;
    }

    myName = name;
    socket.emit('join', myName);
    addLog(`尝试加入项目: ${myName}...`);
    // 注意：不立即切换场景，等待服务器确认
});

// ESC 清空输入
nameInputArea.key(['escape'], () => {
    if (currentScene === 'login') {
        nameInputArea.clearValue();
        screen.render();
    }
});

// 大厅场景
startButton.on('press', () => {
    socket.emit('start');
    addLog('开始项目...');
});

// 大厅场景 - Enter 键开始项目
startButton.key(['enter', 'space'], () => {
    if (!isHost) {
        addLog('只有房主可以开始项目！');
        return;
    }
    socket.emit('start');
    addLog('开始项目...');
});

// 大厅场景全局按键
screen.key(['enter'], () => {
    if (currentScene === 'lobby') {
        if (!isHost) {
            addLog('只有房主可以开始项目！');
            return;
        }
        socket.emit('start');
        addLog('开始项目...');
    }
});

// 项目场景 - 全局按键
screen.key(['space'], () => {
    if (currentScene !== 'game' || !isMyTurn) return;
    if (selectionDialog.visible || infoDialog.visible) return;
    showCardSelection();
});

screen.key(['d', 'D'], () => {
    if (currentScene !== 'game' || !isMyTurn) return;
    if (selectionDialog.visible || infoDialog.visible) return;
    socket.emit('draw');
    addLog('抽牌...');
});

// N 键 - 使用否定卡（在否定窗口激活时）
screen.key(['n', 'N'], () => {
    if (currentScene !== 'game') return;
    if (!nopeWindowActive) return;
    if (selectionDialog.visible || infoDialog.visible) return;

    // 检查是否是自己出的牌
    if (lastPlayedBy === myName) {
        addLog('你不能否定自己的行动！');
        return;
    }

    // 查找手牌中的否定卡
    const nopeCardIndex = myHand.findIndex(card => card.type === '否定');
    if (nopeCardIndex === -1) {
        addLog('你没有否定卡！');
        return;
    }

    // 发送 playNope 事件
    socket.emit('playNope', { cardIndex: nopeCardIndex });
    addLog('使用否定卡...');
});

// ESC 键处理（仅在项目场景）
screen.key(['escape'], () => {
    if (currentScene !== 'game') return;

    if (selectionDialog.visible) {
        selectionDialog.emit('cancel');
        selectionDialog.hide();
        screen.render();
    } else if (infoDialog.visible) {
        infoDialog.hide();
        screen.render();
    }
});

// 选择对话框按键 - blessed list 已内置方向键支持，只需处理确认和取消
selectionDialog.key(['enter'], () => {
    const selected = selectionDialog.selected;
    selectionDialog.emit('select', selectionDialog.items[selected], selected);
});

selectionDialog.key(['escape', 'q'], () => {
    selectionDialog.emit('cancel');
});

// 信息对话框按键
infoDialog.key(['escape', 'enter', 'space', 'q'], () => {
    infoDialog.hide();
    screen.render();
});

// 全局退出
screen.key(['C-c'], () => {
    process.exit(0);
});

// ========== 初始化 ==========
showScene('login');
connectToServer();

addLog('=== 欢迎来到爆炸猫 ===');
addLog('使用方向键选择，Enter确认');
addLog('按 Ctrl+C 退出');

screen.render();
