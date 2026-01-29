// --- Configuration & Scenarios ---
const ISO_BANDS = [
    20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 
    800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000
];

const SCENARIOS = [
    // Level 1: Simulation
    { id: '1-1', type: 'synth', onsetRange: {min: 4.0, max: 8.0}, targetFreqRange: {min: 400, max: 4000} },
    { id: '1-2', type: 'synth', onsetRange: {min: 4.0, max: 8.0}, targetFreqRange: {min: 400, max: 4000} },
    { id: '1-3', type: 'synth', onsetRange: {min: 4.0, max: 8.0}, targetFreqRange: {min: 400, max: 4000} },
    { id: '1-4', type: 'synth', onsetRange: {min: 4.0, max: 8.0}, targetFreqRange: {min: 400, max: 4000} },
    { id: '1-5', type: 'synth', onsetRange: {min: 4.0, max: 8.0}, targetFreqRange: {min: 400, max: 4000} },
    // Level 2: Speech
    { id: '2-1', type: 'audio', path: 'assets/Speech/speech_01002' },
    { id: '2-2', type: 'audio', path: 'assets/Speech/speech_01004' },
    { id: '2-3', type: 'audio', path: 'assets/Speech/speech_01023' },
    { id: '2-4', type: 'audio', path: 'assets/Speech/speech_01002' }, 
    { id: '2-5', type: 'audio', path: 'assets/Speech/speech_01004' },
    // Level 3: Music
    { id: '3-1', type: 'audio', path: 'assets/Music/music_01002' },
    { id: '3-2', type: 'audio', path: 'assets/Music/music_01004' },
    { id: '3-3', type: 'audio', path: 'assets/Music/music_01010' },
    { id: '3-4', type: 'audio', path: 'assets/Music/music_02010' },
    { id: '3-5', type: 'audio', path: 'assets/Music/music_01002' }
];

const RAMP_DURATION = 1.0; 
const ANALYZER_FFT_SIZE = 2048;

// --- State Management ---
const state = {
    mode: 'idle', 
    phase: 1, // 1: Blind, 2: Assisted
    currentQuestionIndex: 0,
    results: [],
    
    // Level 1 で生成した乱数を Phase 2 で再現するためのキャッシュ
    // { index: number, onset: number, freq: number }
    generatedParams: [], 

    // Current Round Data
    targetFreq: 1000,
    startTime: 0,
    currentOnsetStart: 0, 
    currentRampDuration: 1.0,
    reactionTime: null,
    selectedBand: null,
    score: { time: 0, freq: 0, total: 0, distance: 0 },
    
    // Audio
    audioCtx: null,
    nodes: {},
    analyserData: null,
    animationId: null
};

// --- DOM Elements ---
const els = {
    phaseDisplay: document.getElementById('phaseDisplay'),
    status: document.getElementById('statusDisplay'),
    timer: document.getElementById('timerDisplay'),
    screens: {
        idle: document.getElementById('screenIdle'),
        phase2: document.getElementById('screenPhase2'),
        playing: document.getElementById('screenPlaying'),
        geq: document.getElementById('screenGeq'),
        result: document.getElementById('screenResult'),
        fail: document.getElementById('screenFail')
    },
    // Analyzer
    analyzerContainer: document.getElementById('analyzerContainer'),
    analyzerCanvas: document.getElementById('analyzerCanvas'),
    detectedFreq: document.getElementById('detectedFreq'),
    detectedFreqVal: document.getElementById('detectedFreqVal'),
    
    // Results
    geqContainer: document.getElementById('geqContainer'),
    resTime: document.getElementById('resTime'),
    resDiff: document.getElementById('resDiff'),
    resTotal: document.getElementById('resTotal'),
    failTime: document.getElementById('failTime'),
    actualOnset: document.getElementById('actualOnset'),
    
    // Buttons
    btnStart: document.getElementById('btnStart'),
    btnStartPhase2: document.getElementById('btnStartPhase2'),
    btnNext: document.getElementById('btnNext'),
    btnReact: document.getElementById('btnReact'),
    btnRetry: document.getElementById('btnRetry')
};

// --- Helper: CSV Parser ---
function parseCSV(text) {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return null;
    const headers = lines[0].split(',').map(h => h.trim());
    const values = lines[1].split(',').map(v => v.trim());
    const getVal = (key) => {
        const idx = headers.findIndex(h => h === key);
        return idx !== -1 ? values[idx] : null;
    };
    const onsetStart = parseFloat(getVal('Start transition time'));
    const rampLen = parseFloat(getVal('Length transition time'));
    const msgFreq = parseFloat(getVal('MSG frequency'));
    if (isNaN(onsetStart) || isNaN(msgFreq)) return null;
    return { onsetStart, rampDuration: rampLen || 1.0, targetFreq: msgFreq };
}

// --- Audio Loader ---
async function loadExternalData(basePath) {
    const csvRes = await fetch(`${basePath}.csv`);
    if (!csvRes.ok) throw new Error(`CSV not found: ${basePath}`);
    const csvText = await csvRes.text();
    const metadata = parseCSV(csvText);
    const wavRes = await fetch(`${basePath}.wav`);
    const arrayBuffer = await wavRes.arrayBuffer();
    const audioBuffer = await state.audioCtx.decodeAudioData(arrayBuffer);
    return { buffer: audioBuffer, metadata };
}

// --- Audio Engine ---
function initAudio() {
    if (!state.audioCtx) {
        state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (state.audioCtx.state === 'suspended') {
        state.audioCtx.resume();
    }
}

function stopAudio() {
    // 描画ループ停止
    if (state.animationId) {
        cancelAnimationFrame(state.animationId);
        state.animationId = null;
    }
    Object.values(state.nodes).forEach(node => {
        try {
            if (node.stop) node.stop();
            node.disconnect();
        } catch(e) {}
    });
    state.nodes = {};
}

function createNoiseBuffer(ctx) {
    const bufferSize = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = buffer.getChannelData(0);
    let lastOut = 0;
    for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        output[i] = (lastOut + (0.02 * white)) / 1.02;
        lastOut = output[i];
        output[i] *= 3.5;
    }
    return buffer;
}

// --- Analyzer Logic ---
function setupAnalyzer(sourceNode) {
    if (state.phase !== 2) {
        els.analyzerContainer.classList.add('hidden');
        return;
    }
    
    // Canvas & UI 表示
    els.analyzerContainer.classList.remove('hidden');
    
    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = ANALYZER_FFT_SIZE;
    analyser.smoothingTimeConstant = 0.8; // 滑らかに
    sourceNode.connect(analyser);
    state.nodes.analyser = analyser;
    
    const bufferLength = analyser.frequencyBinCount;
    state.analyserData = new Uint8Array(bufferLength);
    
    drawAnalyzer();
}

function drawAnalyzer() {
    if (state.mode !== 'playing') return;
    
    const canvas = els.analyzerCanvas;
    const ctx = canvas.getContext('2d');
    const analyser = state.nodes.analyser;
    
    // Resize handling
    if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
    }
    const width = canvas.width;
    const height = canvas.height;

    state.animationId = requestAnimationFrame(drawAnalyzer);

    analyser.getByteFrequencyData(state.analyserData);

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    const barWidth = (width / state.analyserData.length) * 2.5;
    let barHeight;
    let x = 0;
    
    // ピーク検出用
    let maxVal = 0;
    let maxIndex = 0;
    const threshold = 180; // 検知閾値 (0-255)

    for(let i = 0; i < state.analyserData.length; i++) {
        barHeight = state.analyserData[i] / 255 * height;
        
        // 色の決定
        if (state.analyserData[i] > maxVal) {
            maxVal = state.analyserData[i];
            maxIndex = i;
        }

        let r = barHeight + (25 * (i/state.analyserData.length));
        let g = 250 * (i/state.analyserData.length);
        let b = 50;

        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x, height - barHeight, barWidth, barHeight);

        x += barWidth + 1;
    }

    // ハウリング検知ロジック (簡易版: 閾値を超えた最大ピークを表示)
    if (maxVal > threshold) {
        // インデックスから周波数を計算
        const nyquist = state.audioCtx.sampleRate / 2;
        const detectedFreq = maxIndex * (nyquist / state.analyserData.length);
        
        // UI更新
        els.detectedFreq.classList.remove('hidden');
        els.detectedFreqVal.textContent = Math.round(detectedFreq);
        
        // グラフ上で該当バーを赤くする
        const detectedX = maxIndex * (barWidth + 1);
        ctx.fillStyle = 'red';
        ctx.fillRect(detectedX, 0, barWidth, height); // 全高で赤帯を表示
        
    } else {
        els.detectedFreq.classList.add('hidden');
    }
}


// --- Main Scenario Setup ---
async function setupQuestion() {
    initAudio();
    stopAudio();
    resetUI();

    const ctx = state.audioCtx;
    const t = ctx.currentTime;
    state.startTime = t;

    // Phaseに応じた設定
    if (state.phase === 1) {
        els.phaseDisplay.textContent = "PHASE 1: Blind Test";
        els.phaseDisplay.className = "bg-gray-800 px-2 py-1 rounded border border-gray-600 text-gray-400";
    } else {
        els.phaseDisplay.textContent = "PHASE 2: Assisted Test";
        els.phaseDisplay.className = "bg-purple-900 px-2 py-1 rounded border border-purple-500 text-purple-200 font-bold";
    }

    const currentConfig = SCENARIOS[state.currentQuestionIndex];

    // Master Gain
    const masterGain = ctx.createGain();
    masterGain.gain.value = 0.5; // マスタ音量は0.5のまま
    masterGain.connect(ctx.destination);
    state.nodes.masterGain = masterGain;

    // --- Audio Synthesis / Loading ---
    
    if (currentConfig.type === 'synth') {
        // Level 1: Simulation
        setStatus(`Q${state.currentQuestionIndex + 1}: Simulation`);

        // パラメータ決定ロジック
        if (state.phase === 1) {
            // Phase 1: 新規生成して保存
            const onset = currentConfig.onsetRange.min + Math.random() * (currentConfig.onsetRange.max - currentConfig.onsetRange.min);
            const possibleBands = ISO_BANDS.filter(f => f >= currentConfig.targetFreqRange.min && f <= currentConfig.targetFreqRange.max);
            const baseFreq = possibleBands[Math.floor(Math.random() * possibleBands.length)];
            const jitter = (Math.random() * 0.1) - 0.05;
            const freq = baseFreq * (1 + jitter);
            
            state.currentOnsetStart = onset;
            state.targetFreq = freq;
            
            // 保存
            state.generatedParams[state.currentQuestionIndex] = { onset, freq };
        } else {
            // Phase 2: 保存された値を使用
            const cached = state.generatedParams[state.currentQuestionIndex];
            state.currentOnsetStart = cached.onset;
            state.targetFreq = cached.freq;
        }

        // ノイズ生成 (音量修正: 0.15 -> 0.05)
        const noise = ctx.createBufferSource();
        noise.buffer = createNoiseBuffer(ctx);
        noise.loop = true;
        const noiseGain = ctx.createGain();
        noiseGain.gain.value = 0.05; // 修正点
        noise.connect(noiseGain).connect(masterGain);
        noise.start(t);
        state.nodes.noise = noise;

        // 発振器 (音量修正: Max 0.8 -> 0.2)
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = state.targetFreq;
        
        const howlGain = ctx.createGain();
        howlGain.gain.setValueAtTime(0, t);
        howlGain.gain.setValueAtTime(0.001, t + state.currentOnsetStart);
        // 急激に大きくしすぎない
        howlGain.gain.linearRampToValueAtTime(0.2, t + state.currentOnsetStart + RAMP_DURATION); // 修正点: 0.2

        osc.connect(howlGain).connect(masterGain);
        osc.start(t);
        state.nodes.osc = osc;

        // アナライザー接続 (マスターの前、またはマスターの後)
        // ここではマスターの出力を監視
        setupAnalyzer(masterGain);

    } else if (currentConfig.type === 'audio') {
        // Level 2/3: Audio File
        setStatus(`Q${state.currentQuestionIndex + 1}: Loading...`);
        
        try {
            const data = await loadExternalData(currentConfig.path);
            state.currentOnsetStart = data.metadata.onsetStart;
            state.targetFreq = data.metadata.targetFreq;
            
            const source = ctx.createBufferSource();
            source.buffer = data.buffer;
            
            // ソースをマスターへ
            source.connect(masterGain);
            source.start(t);
            state.nodes.source = source;

            // アナライザー接続
            setupAnalyzer(masterGain);

            setStatus(`Q${state.currentQuestionIndex + 1}: ${currentConfig.id}`);

        } catch (e) {
            console.error(e);
            alert("File Load Error. Check Console.");
            return;
        }
    }

    state.currentRampDuration = RAMP_DURATION;
    setMode('playing');
    requestAnimationFrame(updateTimer);
}


// --- Game Loop & Logic ---
function updateTimer() {
    if (state.mode !== 'playing') return;
    const elapsed = state.audioCtx.currentTime - state.startTime;
    els.timer.textContent = elapsed.toFixed(3);
    
    // Visual Hint (Text Timer color)
    const onsetStart = state.currentOnsetStart;
    if (elapsed >= onsetStart + state.currentRampDuration) els.timer.classList.add('text-red-500');
    else if (elapsed >= onsetStart) els.timer.classList.add('text-yellow-400');
    else els.timer.classList.remove('text-red-500', 'text-yellow-400');

    requestAnimationFrame(updateTimer);
}

function handleReaction() {
    if (state.mode !== 'playing') return;
    
    const pressTime = state.audioCtx.currentTime - state.startTime;
    stopAudio(); // Stop sound & animation

    const onsetStart = state.currentOnsetStart;

    if (pressTime < onsetStart) {
        // Fail
        state.reactionTime = pressTime;
        els.failTime.textContent = pressTime.toFixed(3);
        els.actualOnset.textContent = onsetStart.toFixed(3);
        recordResult(false);
        setMode('fail');
    } else {
        // Success -> Guess Freq
        state.reactionTime = pressTime - onsetStart;
        setMode('guessing');
        renderGEQ();
    }
}

function handleGuess(selectedFreq) {
    state.selectedBand = selectedFreq;
    const correctBand = ISO_BANDS.reduce((prev, curr) => {
        return (Math.abs(curr - state.targetFreq) < Math.abs(prev - state.targetFreq) ? curr : prev);
    });
    
    const targetIndex = ISO_BANDS.indexOf(correctBand);
    const guessIndex = ISO_BANDS.indexOf(selectedFreq);
    const distance = Math.abs(targetIndex - guessIndex);

    let tScore = (state.reactionTime < 0.5) ? 100 : (state.reactionTime < 1.0) ? 80 : (state.reactionTime < 1.5) ? 50 : 10;
    let fScore = (distance === 0) ? 100 : (distance === 1) ? 70 : (distance === 2) ? 30 : 0;

    state.score = {
        time: tScore,
        freq: fScore,
        total: Math.round((tScore + fScore) / 2),
        distance: distance,
        correctBand: correctBand
    };

    recordResult(true);
    renderResult();
    setMode('result');
}

function recordResult(success) {
    state.results.push({
        phase: state.phase,
        qIndex: state.currentQuestionIndex,
        id: SCENARIOS[state.currentQuestionIndex].id,
        success,
        reactionTime: state.reactionTime,
        targetFreq: state.targetFreq,
        selectedBand: state.selectedBand,
        score: state.score
    });
}

function nextQuestion() {
    state.currentQuestionIndex++;
    
    // 全問終了チェック
    if (state.currentQuestionIndex >= SCENARIOS.length) {
        if (state.phase === 1) {
            // Phase 1 終了 -> Phase 2 準備画面へ
            state.phase = 2;
            state.currentQuestionIndex = 0;
            setMode('phase2Start');
        } else {
            // Phase 2 終了 -> 完全終了
            alert("テスト終了！全データはコンソールに出力されています。");
            console.log("--- FINAL RESULTS ---");
            console.table(state.results);
            // CSV出力の代わりにログ表示で終了
        }
    } else {
        setupQuestion();
    }
}

// --- UI Rendering ---
function setStatus(text) {
    els.status.textContent = text;
}

function setMode(mode) {
    state.mode = (mode === 'phase2Start') ? 'idle' : mode; // マッピング調整
    
    // 全画面非表示
    Object.values(els.screens).forEach(el => el.classList.add('hidden'));

    // 該当画面表示
    if (mode === 'idle') els.screens.idle.classList.remove('hidden');
    else if (mode === 'phase2Start') els.screens.phase2.classList.remove('hidden');
    else if (mode === 'playing') els.screens.playing.classList.remove('hidden');
    else if (mode === 'guessing') els.screens.geq.classList.remove('hidden');
    else if (mode === 'result') els.screens.result.classList.remove('hidden');
    else if (mode === 'fail') els.screens.fail.classList.remove('hidden');

    // Canvas表示制御 (Phase2 playing時のみ)
    if (mode === 'playing' && state.phase === 2) {
        els.analyzerContainer.classList.remove('hidden');
    } else {
        els.analyzerContainer.classList.add('hidden');
    }

    // Status Text
    if (mode === 'phase2Start') setStatus("INTERMISSION");
    else if (mode === 'playing') {
        els.status.className = 'text-xl font-bold text-green-400 animate-pulse';
    } else if (mode === 'fail') {
        els.status.className = 'text-xl font-bold text-red-400';
        setStatus('FALSE POSITIVE');
    } else {
        els.status.className = 'text-xl font-bold text-white';
        if (mode === 'guessing') setStatus('SELECT FREQ');
        if (mode === 'result') setStatus('RESULT');
    }
}

function renderGEQ() {
    els.geqContainer.innerHTML = '';
    ISO_BANDS.forEach(freq => {
        const div = document.createElement('div');
        div.className = 'flex flex-col items-center justify-end h-48 w-6';
        
        const track = document.createElement('div');
        track.className = 'fader-track';
        track.onclick = () => handleGuess(freq);

        const thumb = document.createElement('div');
        thumb.className = 'fader-thumb';
        thumb.style.top = '10px'; 
        track.appendChild(thumb);

        const label = document.createElement('span');
        label.className = 'iso-label';
        label.textContent = freq >= 1000 ? (freq/1000) + 'k' : freq;

        div.appendChild(track);
        div.appendChild(label);
        els.geqContainer.appendChild(div);
    });
}

function renderResult() {
    els.resTime.textContent = `+${state.reactionTime?.toFixed(3)}s`;
    els.resDiff.textContent = `${state.selectedBand} Hz`;
    const distText = state.score.distance === 0 ? "Perfect" : `${state.score.distance} band(s) off`;
    els.resDiff.innerHTML += `<br><span class="text-xs text-gray-500">Correct: ${state.score.correctBand}Hz</span>`;
    els.resTotal.textContent = state.score.total;
    
    // ボタンテキスト
    const isLastQ = (state.currentQuestionIndex >= SCENARIOS.length - 1);
    if (isLastQ && state.phase === 1) els.btnNext.textContent = "Go to Phase 2";
    else if (isLastQ && state.phase === 2) els.btnNext.textContent = "Finish Test";
    else els.btnNext.textContent = "Next Question →";
}

function resetUI() {
    els.timer.textContent = "0.000";
    els.timer.className = "text-3xl font-mono text-blue-400";
}

// --- Events ---
els.btnStart.onclick = setupQuestion;
els.btnStartPhase2.onclick = setupQuestion;
els.btnReact.onclick = handleReaction;
els.btnNext.onclick = nextQuestion;
els.btnRetry.onclick = setupQuestion;

window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        e.preventDefault();
        // Phase 2 Start画面でのスペースキー対応
        if (!els.screens.phase2.classList.contains('hidden')) {
             setupQuestion();
             return;
        }
        if (state.mode === 'playing') handleReaction();
        else if (state.mode === 'idle') setupQuestion();
    }
});