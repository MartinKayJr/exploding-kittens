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
        // 强制设置代码页为 UTF-8
        execSync('chcp 65001', { stdio: 'ignore' });
    } catch (e) {
        // 忽略错误
    }
}

const blessed = require('blessed');
const io = require('socket.io-client');

// === 配置 ===
// 从命令行参数读取服务器地址
// 用法: node console-client.js [server_address]
// 示例: node console-client.js 192.168.1.213:3004
//      node console-client.js http://192.168.1.213:3004
function parseServerAddress() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        return 'http://localhost:3004';
    }

    let serverAddr = args[0];

    // 如果没有协议前缀，添加 http://
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
let lastPlayedCard = null; // 最后出的牌
let lastPlayedBy = null; // 最后出牌的玩家

// === 创建屏幕 ===
const screen = blessed.screen({
    smartCSR: true,
    title: 'Exploding Kittens',
    fullUnicode: true,  // 启用完整 Unicode 支持
    forceUnicode: true, // 强制使用 Unicode
    dockBorders: true,
    ignoreDockContrast: true
});

// === UI 组件 ===

// 顶部标题栏
const titleBar = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: '{center}EXPLODING KITTENS{/center}',
    tags: true,
    style: {
        fg: 'white',
        bg: 'black',
        bold: true
    }
});

// 左侧：摸牌区（上半部分 - 牌堆信息）
const deckArea = blessed.box({
    top: 3,
    left: 0,
    width: '25%',
    height: '20%',
    label: ' DECK ',
    border: {
        type: 'line'
    },
    style: {
        fg: 'white',
        border: {
            fg: 'gray'
        }
    },
    tags: true
});

// 左侧：炸弹概率图（下半部分）
const bombRateBox = blessed.box({
    top: '23%',
    left: 0,
    width: '25%',
    height: '20%',
    label: ' BOMB RATE ',
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
    content: '{center}0.0%{/center}'
});

// 中间：出牌区
const playArea = blessed.box({
    top: 3,
    left: '25%',
    width: '50%',
    height: '40%',
    label: ' PLAY AREA ',
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
const playerList = blessed.box({
    top: 3,
    left: '75%',
    width: '25%',
    height: '40%',
    label: ' PLAYERS ',
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

// 游戏日志
const gameLog = blessed.log({
    top: '43%',
    left: 0,
    width: '100%',
    height: '30%',
    label: ' GAME LOG ',
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

// 手牌显示（改为可交互列表）
const handDisplay = blessed.list({
    top: '73%',
    left: 0,
    width: '100%',
    height: 5,
    label: ' MY HAND (← → to select, Enter to play, D to draw) ',
    border: {
        type: 'line'
    },
    style: {
        fg: 'white',
        border: {
            fg: 'gray'
        },
        selected: {
            bg: 'white',
            fg: 'black',
            bold: true
        },
        item: {
            fg: 'white'
        }
    },
    tags: true,
    keys: true,
    vi: true,  // 启用 vi 模式支持方向键
    mouse: true,
    interactive: false,  // 默认不可交互，只在轮到玩家时启用
    scrollbar: {
        ch: ' '
    }
});

// 命令输入框
const commandInput = blessed.textbox({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    label: ' COMMAND (type / then press Tab for hints) ',
    border: {
        type: 'line'
    },
    style: {
        fg: 'white',
        border: {
            fg: 'gray'
        },
        focus: {
            border: {
                fg: 'white'
            }
        }
    },
    inputOnFocus: true
});

// 命令提示框
const hintBox = blessed.box({
    bottom: 3,
    left: 0,
    width: 50,
    height: 'shrink',
    border: {
        type: 'line'
    },
    style: {
        fg: 'white',
        bg: 'black',
        border: {
            fg: 'cyan'
        }
    },
    hidden: true,
    tags: true,
    padding: {
        left: 1,
        right: 1
    }
});

// 选择弹窗（用于选择卡牌或玩家）
const selectionDialog = blessed.list({
    top: 'center',
    left: 'center',
    width: '60%',
    height: '50%',
    label: ' SELECT ',
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

// 添加 Esc 键支持
selectionDialog.key(['escape', 'q'], () => {
    selectionDialog.emit('cancel');
});

// 信息弹窗（用于显示预言、透视等信息）
const infoDialog = blessed.box({
    top: 'center',
    left: 'center',
    width: '70%',
    height: '60%',
    label: ' INFO ',
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
    vi: true,
    mouse: true,
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

// 信息弹窗按任意键关闭
infoDialog.key(['escape', 'enter', 'space', 'q'], () => {
    infoDialog.hide();
    if (isMyTurn && myHand.length > 0) {
        handDisplay.focus();
    } else {
        commandInput.focus();
    }
    screen.render();
});

// === 添加组件到屏幕 ===
screen.append(titleBar);
screen.append(deckArea);
screen.append(bombRateBox);
screen.append(playArea);
screen.append(playerList);
screen.append(gameLog);
screen.append(handDisplay);
screen.append(commandInput);
screen.append(hintBox);
screen.append(selectionDialog);
screen.append(infoDialog);

// === 卡牌渲染函数 ===
function getCardSymbol(cardType) {
    const symbols = {
        '炸弹': '💣',
        '拆除': '🛡',
        '攻击': '🍳',  // 甩锅
        '跳过': '⏭',
        '预言': '🔮',
        '透视': '👁',
        '洗牌': '🔀',
        '抽卡': '🎯',  // 索要
        '否定': '🔄'   // 交换
    };
    return symbols[cardType] || '?';
}

function getCardEnglishName(cardType) {
    const names = {
        '炸弹': 'BOMB',
        '拆除': 'DEFUSE',
        '攻击': 'PASS',      // 甩锅
        '跳过': 'SKIP',
        '预言': 'FUTURE',
        '透视': 'SEE',
        '洗牌': 'SHUFFLE',
        '抽卡': 'STEAL',     // 索要
        '否定': 'SWAP'       // 交换
    };
    return names[cardType] || cardType;
}

function renderCard(cardType, playerName = '') {
    const symbol = getCardSymbol(cardType);
    const englishName = getCardEnglishName(cardType);

    // 英文名称对齐
    const nameLen = englishName.length;
    const topPadding = ' '.repeat(Math.max(0, 7 - nameLen));
    const bottomPadding = ' '.repeat(Math.max(0, 7 - nameLen));

    const lines = [
        '┌─────────┐',
        `│ ${englishName}${topPadding} │`,
        '│         │',
        `│   ${symbol}    │`,
        '│         │',
        `│${bottomPadding}${englishName} │`,
        '└─────────┘'
    ];

    if (playerName) {
        lines.push(`  ${playerName}`);
    }

    return lines.join('\n');
}

// === 辅助函数 ===
function addLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    gameLog.log(`[${timestamp}] ${message}`);
    screen.render();
}

// === 信息弹窗函数 ===
function showInfoDialog(title, content) {
    infoDialog.setLabel(` ${title} (Press any key to close) `);
    infoDialog.setContent(content);
    infoDialog.show();
    infoDialog.focus();
    screen.render();
}

// === 选择弹窗函数 ===
function showCardSelection(title, onSelect, onCancel) {
    if (myHand.length === 0) {
        addLog('No cards to select');
        return;
    }

    // 清除之前的事件监听器
    selectionDialog.removeAllListeners('select');
    selectionDialog.removeAllListeners('cancel');

    selectionDialog.setLabel(` ${title} (↑↓ move, Enter select, Esc cancel) `);
    const items = myHand.map((card, idx) => {
        const symbol = getCardSymbol(card.type);
        const name = getCardEnglishName(card.type);
        return `[${idx}] ${symbol} ${name}`;
    });

    selectionDialog.setItems(items);
    selectionDialog.select(0);
    selectionDialog.show();
    selectionDialog.focus();
    screen.render();

    // 处理选择
    selectionDialog.once('select', (item, index) => {
        selectionDialog.hide();
        commandInput.focus();
        screen.render();
        if (onSelect) onSelect(index);
    });

    // 处理取消（按 Esc）
    selectionDialog.once('cancel', () => {
        selectionDialog.hide();
        commandInput.focus();
        screen.render();
        if (onCancel) onCancel();
    });
}

function showPlayerSelection(title, onSelect, onCancel) {
    const alivePlayers = currentPlayers.filter(p => p.id !== socket.id && p.isAlive);

    if (alivePlayers.length === 0) {
        addLog('No available targets');
        return;
    }

    // 清除之前的事件监听器
    selectionDialog.removeAllListeners('select');
    selectionDialog.removeAllListeners('cancel');

    selectionDialog.setLabel(` ${title} (↑↓ move, Enter select, Esc cancel) `);
    const items = alivePlayers.map((p, idx) => {
        const attackBadge = p.attackCount > 0 ? ` +${p.attackCount}` : '';
        const realIdx = currentPlayers.indexOf(p) + 1;
        return `[${realIdx}] ${p.name}${attackBadge} [${p.cardCount} cards]`;
    });

    selectionDialog.setItems(items);
    selectionDialog.select(0);
    selectionDialog.show();
    selectionDialog.focus();
    screen.render();

    // 处理选择
    selectionDialog.once('select', (item, index) => {
        selectionDialog.hide();
        commandInput.focus();
        screen.render();
        const selectedPlayer = alivePlayers[index];
        if (onSelect) onSelect(selectedPlayer);
    });

    // 处理取消（按 Esc）
    selectionDialog.once('cancel', () => {
        selectionDialog.hide();
        commandInput.focus();
        screen.render();
        if (onCancel) onCancel();
    });
}

function updateDeckArea() {
    if (!gameState) {
        deckArea.setContent('{center}Waiting...{/center}');
        bombRateBox.setContent('{center}\n\n{green-fg}SAFE{/green-fg}\n{bold}0.0%{/bold}{/center}');
        screen.render();
        return;
    }

    const deckCount = gameState.deckCount || 0;
    const bombsInDeck = gameState.bombsInDeck || 0;
    const probability = deckCount > 0 ? ((bombsInDeck / deckCount) * 100).toFixed(1) : '0.0';
    const probNum = parseFloat(probability);

    // Draw deck info
    let content = '\n';
    content += '  ╔═══════╗\n';
    content += '  ║ ■ ■ ■ ║\n';
    content += '  ║ ■ ■ ■ ║\n';
    content += '  ╚═══════╝\n';
    content += '\n';
    content += `  Cards: {bold}${deckCount}{/bold}\n`;
    content += `  Bombs: {bold}${bombsInDeck}{/bold}`;

    deckArea.setContent(content);

    // Update bomb rate display
    let rateColor = 'green-fg';
    let rateLabel = 'SAFE';
    let barColor = 'green-fg';

    if (bombsInDeck === 0) {
        rateColor = 'green-fg';
        rateLabel = 'NO BOMB';
        barColor = 'green-fg';
    } else if (probNum > 50) {
        rateColor = 'red-fg';
        rateLabel = 'DANGER';
        barColor = 'red-fg';
    } else if (probNum > 25) {
        rateColor = 'yellow-fg';
        rateLabel = 'WARN';
        barColor = 'yellow-fg';
    } else {
        rateColor = 'green-fg';
        rateLabel = 'SAFE';
        barColor = 'green-fg';
    }

    // Create visual progress bar
    const barWidth = 16;
    const filledWidth = Math.round((probNum / 100) * barWidth);
    const emptyWidth = barWidth - filledWidth;
    const filled = '█'.repeat(filledWidth);
    const empty = '░'.repeat(emptyWidth);

    let rateContent = '\n';
    rateContent += `{center}{${rateColor}}{bold}${rateLabel}{/bold}{/${rateColor}}{/center}\n`;
    rateContent += '\n';
    rateContent += `{center}{bold}${probability}%{/bold}{/center}\n`;
    rateContent += '\n';
    rateContent += `{center}{${barColor}}${filled}{/${barColor}}{gray-fg}${empty}{/gray-fg}{/center}\n`;

    bombRateBox.setContent(rateContent);

    screen.render();
}

function updatePlayArea() {
    if (!lastPlayedCard || !lastPlayedBy) {
        playArea.setContent('{center}\n\n\nWaiting for player...{/center}');
        screen.render();
        return;
    }

    const card = renderCard(lastPlayedCard, lastPlayedBy);
    playArea.setContent('\n' + card);
    screen.render();
}

function updatePlayerList() {
    let content = '\n';
    currentPlayers.forEach((p, idx) => {
        const isMe = p.id === (socket ? socket.id : null);
        const isCurrent = gameState && p.id === gameState.currentPlayerId;
        const aliveMark = p.isAlive ? '' : ' [DEAD]';
        const meMark = isMe ? ' (YOU)' : '';
        const attackMark = p.attackCount > 0 ? ` +${p.attackCount}` : '';

        let line = '';
        if (isCurrent) {
            line = `{inverse} > ${idx + 1}. ${p.name}${meMark}${attackMark}${aliveMark} [${p.cardCount}] {/inverse}`;
        } else {
            line = `   ${idx + 1}. ${p.name}${meMark}${attackMark}${aliveMark} [${p.cardCount}]`;
        }

        content += line + '\n';
    });

    playerList.setContent(content);
    screen.render();
}

function updateHandDisplay() {
    if (myHand.length === 0) {
        handDisplay.clearItems();
        handDisplay.setItems(['No cards']);
        handDisplay.interactive = false;
        handDisplay.setLabel(' MY HAND ');
        handDisplay.style.border.fg = 'gray';
        screen.render();
        return;
    }

    const items = myHand.map((card, idx) => {
        const symbol = getCardSymbol(card.type);
        const englishName = getCardEnglishName(card.type);
        return `[${idx}] ${symbol} ${englishName}`;
    });

    handDisplay.setItems(items);

    // 只在轮到玩家时才允许交互
    if (isMyTurn) {
        handDisplay.interactive = true;
        handDisplay.setLabel(' MY HAND (← → to select, Enter to play, D to draw) ');
        handDisplay.style.border.fg = 'cyan';  // 高亮边框
        if (items.length > 0 && handDisplay.selected === undefined) {
            handDisplay.select(0);  // 默认选中第一张牌
        }
    } else {
        handDisplay.interactive = false;
        handDisplay.setLabel(' MY HAND (waiting for your turn) ');
        handDisplay.style.border.fg = 'gray';
    }

    screen.render();
}

function updateTitleBar() {
    let status = '{center}EXPLODING KITTENS';
    if (myName) {
        status += ` - ${myName}`;
    }
    if (gameState && gameState.gameStatus === 'playing') {
        if (isMyTurn) {
            status += ' {inverse} YOUR TURN {/inverse}';
            if (gameState.turnsLeft > 1) {
                status += ` (${gameState.turnsLeft} left)`;
            }
        }
    }
    status += '{/center}';
    titleBar.setContent(status);
    screen.render();
}

// === Command definitions ===
const commands = {
    '/join': {
        desc: 'Join the game',
        usage: '/join <name>',
        exec: (args) => {
            if (!args[0]) {
                addLog('Usage: /join <name>');
                return;
            }
            myName = args[0];
            socket.emit('join', myName);
            addLog(`Joining as ${myName}...`);
        }
    },
    '/start': {
        desc: 'Start the game',
        usage: '/start',
        exec: () => {
            socket.emit('start');
            addLog('Starting game...');
        }
    },
    '/draw': {
        desc: 'Draw a card',
        usage: '/draw',
        exec: () => {
            if (!isMyTurn) {
                addLog('Not your turn!');
                return;
            }
            socket.emit('draw');
            addLog('Drawing...');
        }
    },
    '/play': {
        desc: 'Play a card',
        usage: '/play <index>',
        exec: (args) => {
            if (!isMyTurn) {
                addLog('Not your turn!');
                return;
            }
            const index = parseInt(args[0]);
            if (isNaN(index) || index < 0 || index >= myHand.length) {
                addLog('Invalid card index!');
                return;
            }
            socket.emit('play', { index });
            addLog(`Playing card ${index}...`);
        }
    },
    '/hand': {
        desc: 'Show hand (when not your turn)',
        usage: '/hand',
        exec: () => {
            updateHandDisplay();
            addLog('Hand displayed');
        }
    },
    '/help': {
        desc: 'Show help',
        usage: '/help',
        exec: () => {
            addLog('=== Available Commands ===');
            Object.entries(commands).forEach(([cmd, info]) => {
                addLog(`${info.usage} - ${info.desc}`);
            });
        }
    },
    '/quit': {
        desc: 'Quit',
        usage: '/quit',
        exec: () => {
            process.exit(0);
        }
    },
    '/clear': {
        desc: 'Clear log',
        usage: '/clear',
        exec: () => {
            gameLog.setContent('');
            screen.render();
        }
    }
};

// Bomb position command
commands['/bomb'] = {
    desc: 'Place bomb (0=top, 1=2nd, 2=3rd, -1=bottom)',
    usage: '/bomb <pos>',
    exec: (args) => {
        const pos = parseInt(args[0]);
        if (isNaN(pos)) {
            addLog('Usage: /bomb <pos>');
            return;
        }
        socket.emit('insertBomb', pos);
        addLog('Placing bomb...');
    }
};

// Give card command
commands['/give'] = {
    desc: 'Give card',
    usage: '/give <index>',
    exec: (args) => {
        const index = parseInt(args[0]);
        if (isNaN(index) || index < 0 || index >= myHand.length) {
            addLog('Invalid card index!');
            return;
        }
        if (!pendingRequesterId) {
            addLog('No pending card request!');
            return;
        }
        socket.emit('giveCardResponse', {
            cardIndex: index,
            requesterId: pendingRequesterId
        });
        addLog(`Giving card ${index}...`);
        pendingRequesterId = null;
    }
};

// Target selection command
let pendingCardIndex = -1;
commands['/target'] = {
    desc: 'Select target',
    usage: '/target <player#>',
    exec: (args) => {
        const playerIdx = parseInt(args[0]);
        if (isNaN(playerIdx) || playerIdx < 1) {
            addLog('Invalid player number!');
            return;
        }

        const targetIdx = playerIdx - 1; // Convert to 0-based index
        const alivePlayers = currentPlayers.filter(p => p.id !== socket.id && p.isAlive);

        if (targetIdx >= alivePlayers.length) {
            addLog('Player number out of range!');
            return;
        }

        const targetPlayer = currentPlayers[targetIdx];
        if (!targetPlayer || !targetPlayer.isAlive || targetPlayer.id === socket.id) {
            addLog('Invalid target player!');
            return;
        }

        if (pendingCardIndex >= 0) {
            socket.emit('play', {
                index: pendingCardIndex,
                targetId: targetPlayer.id
            });
            addLog(`Playing card ${pendingCardIndex} on ${targetPlayer.name}...`);
            pendingCardIndex = -1;
        } else {
            addLog('No card selected! Use /play <index> first');
        }
    }
};

// === Execute command ===
function executeCommand(input) {
    input = input.trim();
    if (!input) return;

    if (!input.startsWith('/')) {
        addLog('Commands must start with /');
        return;
    }

    const parts = input.split(' ');
    const cmd = parts[0];
    const args = parts.slice(1);

    if (commands[cmd]) {
        commands[cmd].exec(args);
    } else {
        addLog(`Unknown command: ${cmd}`);
        addLog('Type /help for available commands');
    }
}

// === Socket.IO connection ===
function connectToServer() {
    addLog(`Connecting to server: ${SERVER_URL}`);

    socket = io(SERVER_URL);

    socket.on('connect', () => {
        addLog(`Connected to ${SERVER_URL}`);
        addLog('Type /join <name> to join game');
    });

    socket.on('disconnect', () => {
        addLog('Disconnected from server');
    });

    socket.on('playerList', (players) => {
        currentPlayers = players;
        updatePlayerList();
    });

    socket.on('gameState', (state) => {
        gameState = state;
        currentPlayers = state.players;
        const wasMyTurn = isMyTurn;
        isMyTurn = state.currentPlayerId === socket.id;

        updatePlayerList();
        updateDeckArea();
        updateTitleBar();

        // 如果轮到我的回合，自动显示手牌并聚焦
        if (isMyTurn && !wasMyTurn) {
            updateHandDisplay();
            // 自动聚焦到手牌区域
            if (myHand.length > 0) {
                handDisplay.focus();
                addLog('YOUR TURN! Use ← → to select card, Enter to play, D to draw');
            }
        } else if (!isMyTurn) {
            // 不是我的回合，显示等待信息
            updateHandDisplay();
            commandInput.focus();  // 切回命令输入
        }
    });

    socket.on('handUpdate', (hand) => {
        myHand = hand;
        updateHandDisplay();
    });

    socket.on('gameLog', (data) => {
        addLog(data.message);
    });

    socket.on('gameOver', (winner) => {
        addLog(`Game Over! Winner: ${winner}`);
        lastPlayedCard = null;
        lastPlayedBy = null;
        updatePlayArea();
    });

    socket.on('selectTarget', (data) => {
        pendingCardIndex = data.cardIndex;
        const cardName = getCardEnglishName(data.cardType);
        addLog(`Select target for ${cardName}`);

        // 显示玩家选择弹窗
        showPlayerSelection(
            `SELECT TARGET FOR ${cardName}`,
            (selectedPlayer) => {
                // 选择了玩家
                socket.emit('play', {
                    index: pendingCardIndex,
                    targetId: selectedPlayer.id
                });
                addLog(`Playing card ${pendingCardIndex} on ${selectedPlayer.name}...`);
                pendingCardIndex = -1;
            },
            () => {
                // 取消选择
                addLog('Target selection cancelled');
                pendingCardIndex = -1;
            }
        );
    });

    socket.on('showFutureText', (text) => {
        // 预言卡效果 - 弹窗显示
        let content = '\n{center}{bold}🔮 FUTURE PREDICTION{/bold}{/center}\n\n';
        content += `{center}${text}{/center}\n\n`;
        content += '{center}{gray-fg}Press any key to close{/gray-fg}{/center}';

        showInfoDialog('🔮 FUTURE', content);
        addLog(text);  // 同时记录到日志
    });

    socket.on('showFuture', (cards) => {
        // 透视卡效果 - 弹窗显示顶部3张牌
        let content = '\n{center}{bold}👁 SEE FUTURE - TOP 3 CARDS{/bold}{/center}\n\n';

        if (cards.length === 0) {
            content += '{center}No cards in deck{/center}\n';
        } else {
            cards.forEach((card, idx) => {
                const symbol = getCardSymbol(card.type);
                const englishName = getCardEnglishName(card.type);
                content += `{center}${idx + 1}. ${symbol} {bold}${englishName}{/bold}{/center}\n`;
            });
        }

        content += '\n{center}{gray-fg}Press any key to close{/gray-fg}{/center}';

        showInfoDialog('👁 SEE FUTURE', content);
        addLog('Used SEE card to view top 3 cards');
    });

    socket.on('askBombPosition', () => {
        addLog('Bomb defused! Choose position to place the bomb');

        // 炸弹位置选择弹窗
        selectionDialog.removeAllListeners('select');
        selectionDialog.removeAllListeners('cancel');

        selectionDialog.setLabel(' 💣 PLACE BOMB (↑↓ move, Enter select) ');
        const options = [
            '0. Top (next card) - Most dangerous!',
            '1. Second card',
            '2. Third card',
            '-1. Bottom - Safest!'
        ];

        selectionDialog.setItems(options);
        selectionDialog.select(0);
        selectionDialog.show();
        selectionDialog.focus();
        screen.render();

        selectionDialog.once('select', (item, index) => {
            selectionDialog.hide();
            const positions = [0, 1, 2, -1];
            const pos = positions[index];

            socket.emit('insertBomb', pos);
            addLog(`Placing bomb at position ${pos}...`);

            if (isMyTurn && myHand.length > 0) {
                handDisplay.focus();
            } else {
                commandInput.focus();
            }
            screen.render();
        });

        selectionDialog.once('cancel', () => {
            selectionDialog.hide();
            addLog('Must choose a position for the bomb');
            // 重新显示选择（不能取消）
            setTimeout(() => {
                socket.emit('askBombPosition');
            }, 100);
            screen.render();
        });
    });

    socket.on('giveCard', (data) => {
        pendingRequesterId = data.requesterId;
        addLog(`${data.requesterName} is requesting a card!`);

        // 显示手牌选择弹窗
        showCardSelection(
            `GIVE CARD TO ${data.requesterName}`,
            (cardIndex) => {
                // 选择了卡牌
                socket.emit('giveCardResponse', {
                    cardIndex: cardIndex,
                    requesterId: pendingRequesterId
                });
                const cardName = getCardEnglishName(myHand[cardIndex].type);
                addLog(`Giving ${cardName} to ${data.requesterName}...`);
                pendingRequesterId = null;
            },
            () => {
                // 取消选择（虽然游戏规则可能不允许取消）
                addLog('Card selection cancelled');
            }
        );
    });

    // 监听出牌事件来更新出牌区
    socket.on('cardPlayed', (data) => {
        lastPlayedCard = data.cardType;
        lastPlayedBy = data.playerName;
        updatePlayArea();

        // 添加动画效果 - 闪烁边框
        const originalBorder = playArea.style.border.fg;
        playArea.style.border.fg = 'white';
        screen.render();
        setTimeout(() => {
            playArea.style.border.fg = originalBorder;
            screen.render();
        }, 300);
    });
}

// === 命令提示功能 ===
function showHints() {
    const input = commandInput.getValue();

    // 如果输入为空或不是以 / 开头，隐藏提示
    if (!input || !input.startsWith('/')) {
        hintBox.hide();
        screen.render();
        return;
    }

    // 如果只输入了 /，显示所有命令
    if (input.trim() === '/') {
        let content = '{bold}Available Commands:{/bold}\n';
        Object.entries(commands).slice(0, 8).forEach(([cmd, info]) => {
            content += `{green-fg}${cmd}{/green-fg} - {gray-fg}${info.desc}{/gray-fg}\n`;
        });
        hintBox.setContent(content);
        hintBox.show();
        screen.render();
        return;
    }

    const parts = input.trim().split(' ');
    const cmd = parts[0];

    // 查找匹配的命令
    const matching = Object.keys(commands).filter(c =>
        c.startsWith(cmd) && c !== cmd
    );

    if (matching.length === 0) {
        // 显示当前命令的用法
        if (commands[cmd]) {
            const info = commands[cmd];
            let content = `{cyan-fg}${info.usage}{/cyan-fg}\n`;
            content += `{gray-fg}${info.desc}{/gray-fg}`;
            hintBox.setContent(content);
            hintBox.show();
        } else {
            hintBox.hide();
        }
    } else {
        // 显示匹配的命令列表
        let content = '{bold}Available:{/bold}\n';
        matching.slice(0, 5).forEach(c => {
            content += `{green-fg}${c}{/green-fg} - {gray-fg}${commands[c].desc}{/gray-fg}\n`;
        });
        hintBox.setContent(content);
        hintBox.show();
    }

    screen.render();
}

// 监听输入变化
let lastInputValue = '';
setInterval(() => {
    const current = commandInput.getValue();
    if (current !== lastInputValue) {
        lastInputValue = current;
        if (current.startsWith('/')) {
            showHints();
        } else {
            // 如果不是以 / 开头，隐藏提示框
            hintBox.hide();
            screen.render();
        }
    }
}, 100);

// === 手牌区域键盘事件 ===

// 上下左右方向键
handDisplay.key(['up', 'k'], () => {
    if (!isMyTurn || myHand.length === 0) return;
    handDisplay.up();
    screen.render();
});

handDisplay.key(['down', 'j'], () => {
    if (!isMyTurn || myHand.length === 0) return;
    handDisplay.down();
    screen.render();
});

handDisplay.key(['left', 'h'], () => {
    if (!isMyTurn || myHand.length === 0) return;
    handDisplay.up();  // 在列表中，左=上
    screen.render();
});

handDisplay.key(['right', 'l'], () => {
    if (!isMyTurn || myHand.length === 0) return;
    handDisplay.down();  // 在列表中，右=下
    screen.render();
});

handDisplay.key(['enter'], () => {
    if (!isMyTurn) {
        addLog('Not your turn!');
        return;
    }

    const selectedIndex = handDisplay.selected;
    if (selectedIndex >= 0 && selectedIndex < myHand.length) {
        // 出选中的牌
        socket.emit('play', { index: selectedIndex });
        addLog(`Playing card ${selectedIndex}...`);
    }
});

handDisplay.key(['d', 'D'], () => {
    if (!isMyTurn) {
        addLog('Not your turn!');
        return;
    }

    // 抽牌
    socket.emit('draw');
    addLog('Drawing...');
});

handDisplay.key(['escape'], () => {
    // 切换回命令输入
    commandInput.focus();
    screen.render();
});

handDisplay.key(['tab'], () => {
    // 切换回命令输入
    commandInput.focus();
    screen.render();
});

// === 命令输入键盘事件 ===
commandInput.on('submit', (value) => {
    hintBox.hide();
    executeCommand(value);
    commandInput.clearValue();
    commandInput.focus();
    screen.render();
});

commandInput.key(['tab'], () => {
    const input = commandInput.getValue();
    if (input.startsWith('/')) {
        // Tab 键显示/隐藏提示
        if (hintBox.hidden) {
            showHints();
        } else {
            hintBox.hide();
            screen.render();
        }
    }
});

// === 全局键盘事件 ===
screen.key(['C-c'], () => {
    process.exit(0);
});

screen.key(['tab'], () => {
    // 如果是玩家回合且有手牌，聚焦到手牌区域
    if (isMyTurn && myHand.length > 0) {
        handDisplay.focus();
    } else {
        commandInput.focus();
    }
    screen.render();
});

screen.key(['escape'], () => {
    hintBox.hide();
    selectionDialog.hide();
    infoDialog.hide();
    commandInput.clearValue();
    commandInput.focus();
    screen.render();
});

// === 初始化 ===
commandInput.focus();
screen.render();
connectToServer();

// Show welcome message
addLog('=== Welcome to Exploding Kittens ===');
addLog('Press Tab to focus command input');
addLog('Type /help to see commands');
addLog('Press Ctrl+C to quit');
