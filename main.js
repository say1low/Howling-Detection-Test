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
// dB範囲の定義
const MIN_DB = -100;
const MAX_DB = -10; 
// ピーク値の減衰速度 (dB per frame)
const PEAK_DECAY = 0.5; 
// 履歴バッファサイズ (フレーム数)
const HISTORY_SIZE = 64;
// 【タスク2-2】動的閾値の係数 (標準偏差の何倍を閾値とするか)
const DYNAMIC_THRESHOLD_ALPHA = 6.0;

// --- State Management ---
const state = {
    mode: 'idle', 
    phase: 1, // 1: Blind, 2: Assisted
    currentQuestionIndex: 0,
    results: [],
    generatedParams: [], 
    targetFreq: 1000,
    startTime: 0,
    currentOnsetStart: 0, 
    currentRampDuration: 1.0,
    reactionTime: null,
    selectedBand: null,
    score: { time: 0, freq: 0, total: 0, distance: 0 },
    audioCtx: null,
    nodes: {},
    analyserData: null,
    peakValues: null,
    // 線形振幅の履歴
    linearHistory: [],
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
    analyzerContainer: document.getElementById('analyzerContainer'),
    analyzerCanvas: document.getElementById('analyzerCanvas'),
    detectedFreq: document.getElementById('detectedFreq'),
    detectedFreqVal: document.getElementById('detectedFreqVal'),
    geqContainer: document.getElementById('geqContainer'),
    resTime: document.getElementById('resTime'),
    resDiff: document.getElementById('resDiff'),
    resTotal: document.getElementById('resTotal'),
    failTime: document.getElementById('failTime'),
    actualOnset: document.getElementById('actualOnset'),
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

// --- Analyzer Logic (Refactored) ---

function interpolate(v1, v2, fraction) {
    if (!isFinite(v1)) v1 = MIN_DB;
    if (!isFinite(v2)) v2 = MIN_DB;
    return v1 + (v2 - v1) * fraction;
}

function normalizeDb(db) {
    return Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)));
}

function setupAnalyzer(sourceNode) {
    if (state.phase !== 2) {
        els.analyzerContainer.classList.add('hidden');
        return;
    }
    
    els.analyzerContainer.classList.remove('hidden');
    
    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = ANALYZER_FFT_SIZE;
    analyser.smoothingTimeConstant = 0.8;
    analyser.minDecibels = MIN_DB;
    analyser.maxDecibels = MAX_DB;
    
    sourceNode.connect(analyser);
    state.nodes.analyser = analyser;
    
    const bufferLength = analyser.frequencyBinCount;
    state.analyserData = new Float32Array(bufferLength);
    state.peakValues = new Float32Array(bufferLength).fill(MIN_DB);
    state.linearHistory = [];
}

function startAnalyzerLoop() {
    if (state.phase === 2 && state.mode === 'playing') {
        updateAnalyzerLoop();
    }
}

function updateAnalyzerLoop() {
    if (state.mode !== 'playing') return;

    state.animationId = requestAnimationFrame(updateAnalyzerLoop);

    const analyser = state.nodes.analyser;
    if (!analyser) return;

    analyser.getFloatFrequencyData(state.analyserData);

    // ピーク値の更新と減衰
    for (let i = 0; i < state.analyserData.length; i++) {
        const currentDb = state.analyserData[i];
        if (currentDb > state.peakValues[i]) {
            state.peakValues[i] = currentDb; 
        } else {
            state.peakValues[i] -= PEAK_DECAY; 
            if (state.peakValues[i] < MIN_DB) state.peakValues[i] = MIN_DB;
        }
    }

    // 履歴バッファへの追加 (dB -> Linear変換)
    const binCount = state.analyserData.length;
    const linearData = new Float32Array(binCount);
    for (let i = 0; i < binCount; i++) {
        // dBFS to Linear Amplitude: 10^(dB/20)
        linearData[i] = Math.pow(10, state.analyserData[i] / 20);
    }
    
    state.linearHistory.push(linearData);
    if (state.linearHistory.length > HISTORY_SIZE) {
        state.linearHistory.shift(); // FIFO (古いものを捨てる)
    }

    // 【タスク2-2】現在のリニアデータを使ってピーク検知
    const currentLinear = state.linearHistory[state.linearHistory.length - 1];
    const peakInfo = detectPeak(state.analyserData, currentLinear);

    drawSpectrum(state.analyserData, peakInfo);

    updateAnalyzerUI(peakInfo);
}

// 【タスク2-2】detectPeak関数を統計的アプローチに更新
function detectPeak(dbData, linearData) {
    let maxValDb = -Infinity; 
    let maxIndex = 0;

    // 1. 最大音量のビンを探す (dBデータを使用)
    for(let i = 0; i < dbData.length; i++) {
        if (dbData[i] > maxValDb) {
            maxValDb = dbData[i];
            maxIndex = i;
        }
    }

    let detected = false;
    
    // 2. 統計情報の計算 (リニアデータを使用)
    if (linearData && linearData.length > 0) {
        let sum = 0;
        let sumSq = 0;
        const len = linearData.length;
        
        for (let i = 0; i < len; i++) {
            const v = linearData[i];
            sum += v;
            sumSq += v * v;
        }
        
        const mean = sum / len;
        const variance = (sumSq / len) - (mean * mean);
        const stdDev = Math.sqrt(Math.max(0, variance));
        
        // 動的閾値: 平均 + α * 標準偏差
        const dynamicThreshold = mean + (DYNAMIC_THRESHOLD_ALPHA * stdDev);
        
        // 最大値が動的閾値を超えているか？
        detected = linearData[maxIndex] > dynamicThreshold;
        
        // 無音に近い状態での誤検知防止 (最小dBチェック)
        if (maxValDb < -80) {
            detected = false;
        }
    }

    const nyquist = state.audioCtx.sampleRate / 2;
    const freq = maxIndex * (nyquist / dbData.length);

    return { detected, freq, maxIndex, maxVal: maxValDb };
}

function drawGrid(ctx, w, h, bufferLength) {
    if (!state.audioCtx) return;
    const sampleRate = state.audioCtx.sampleRate;
    
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'; 
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';    
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';

    const freqTargets = [100, 1000, 10000];
    
    freqTargets.forEach(f => {
        const nyquist = sampleRate / 2;
        const index = (f / nyquist) * bufferLength;
        
        if (index < 1) return; 
        
        const percent = Math.log(index) / Math.log(bufferLength - 1);
        const x = w * percent;
        
        if (x >= 0 && x <= w) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
            
            const label = f >= 1000 ? (f/1000) + 'k' : f;
            ctx.fillText(label, x, h - 2);
        }
    });

    ctx.textAlign = 'left';
    
    for (let db = MAX_DB - 10; db > MIN_DB; db -= 20) {
        const normalized = (db - MIN_DB) / (MAX_DB - MIN_DB);
        const y = h - (normalized * h);
        
        if (y >= 0 && y <= h) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
            ctx.fillText(db + 'dB', 2, y - 2);
        }
    }
}

// 5. Drawing: Canvasへの描画のみを行う
function drawSpectrum(data, peakInfo) {
    const canvas = els.analyzerCanvas;
    const ctx = canvas.getContext('2d');
    
    if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
    }
    const width = canvas.width;
    const height = canvas.height;
    const bufferLength = data.length;

    // Clear (Background)
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    drawGrid(ctx, width, height, bufferLength);

    // --- Create Gradient ---
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(0, 242, 255, 0.6)');   // Top: Cyan
    gradient.addColorStop(0.5, 'rgba(0, 242, 255, 0.2)'); // Mid
    gradient.addColorStop(1, 'rgba(0, 242, 255, 0.0)');   // Bottom: Transparent

    // --- Path for Fill (Main Spectrum) ---
    ctx.beginPath();
    ctx.moveTo(0, height); 

    // 対数スケールで描画ポイントを計算
    for (let x = 0; x <= width; x++) {
        const percent = x / width;
        const logIndex = 1 * Math.pow((bufferLength - 1) / 1, percent);
        const iBase = Math.floor(logIndex);
        const iFrac = logIndex - iBase;
        
        const v1 = data[iBase];
        const v2 = data[iBase + 1];
        const valDb = interpolate(v1, v2, iFrac);

        const normalizedVal = normalizeDb(valDb);
        const y = height - (normalizedVal * height);

        ctx.lineTo(x, y);
    }

    ctx.lineTo(width, height); 
    ctx.closePath(); 

    // Fill
    ctx.fillStyle = gradient;
    ctx.fill();

    // --- Path for Stroke (Line) ---
    ctx.beginPath();
    for (let x = 0; x <= width; x++) {
        const percent = x / width;
        const logIndex = 1 * Math.pow((bufferLength - 1) / 1, percent);
        const iBase = Math.floor(logIndex);
        const iFrac = logIndex - iBase;
        const valDb = interpolate(data[iBase], data[iBase + 1], iFrac);
        const normalizedVal = normalizeDb(valDb);
        const y = height - (normalizedVal * height);

        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    
    ctx.strokeStyle = '#00f2ff'; // Cyan Line
    ctx.lineWidth = 2;
    ctx.stroke();

    // --- Path for Peak Hold (Yellow Dashed Line) ---
    if (state.peakValues) {
        ctx.beginPath();
        for (let x = 0; x <= width; x++) {
            const percent = x / width;
            const logIndex = 1 * Math.pow((bufferLength - 1) / 1, percent);
            const iBase = Math.floor(logIndex);
            const iFrac = logIndex - iBase;
            
            const p1 = state.peakValues[iBase];
            const p2 = state.peakValues[iBase + 1];
            const peakDb = interpolate(p1, p2, iFrac);
            
            const normalizedPeak = normalizeDb(peakDb);
            const y = height - (normalizedPeak * height);

            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'rgba(255, 235, 59, 0.8)'; // Yellow
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]); // 破線
        ctx.stroke();
        ctx.setLineDash([]); // リセット
    }

    // Highlight Peak (Detection Indicator)
    if (peakInfo.detected) {
        const safeIndex = Math.max(1, peakInfo.maxIndex); 
        const percent = Math.log(safeIndex) / Math.log(bufferLength - 1);
        const detectedX = width * percent;
        
        const highlightWidth = 4;

        ctx.fillStyle = 'rgba(255, 50, 50, 0.8)'; 
        ctx.fillRect(detectedX - highlightWidth/2, 0, highlightWidth, height);
    }
}

function updateAnalyzerUI(peakInfo) {
    if (peakInfo.detected) {
        els.detectedFreq.classList.remove('hidden');
        els.detectedFreqVal.textContent = Math.round(peakInfo.freq);
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

    if (state.phase === 1) {
        els.phaseDisplay.textContent = "PHASE 1: Blind Test";
        els.phaseDisplay.className = "bg-gray-800 px-2 py-1 rounded border border-gray-600 text-gray-400";
    } else {
        els.phaseDisplay.textContent = "PHASE 2: Assisted Test";
        els.phaseDisplay.className = "bg-purple-900 px-2 py-1 rounded border border-purple-500 text-purple-200 font-bold";
    }

    const currentConfig = SCENARIOS[state.currentQuestionIndex];

    const masterGain = ctx.createGain();
    masterGain.gain.value = 0.5;
    masterGain.connect(ctx.destination);
    state.nodes.masterGain = masterGain;
    
    // --- Synth Mode ---
    if (currentConfig.type === 'synth') {
        setStatus(`Q${state.currentQuestionIndex + 1}: Simulation`);

        if (state.phase === 1) {
            const onset = currentConfig.onsetRange.min + Math.random() * (currentConfig.onsetRange.max - currentConfig.onsetRange.min);
            const possibleBands = ISO_BANDS.filter(f => f >= currentConfig.targetFreqRange.min && f <= currentConfig.targetFreqRange.max);
            const baseFreq = possibleBands[Math.floor(Math.random() * possibleBands.length)];
            const jitter = (Math.random() * 0.1) - 0.05;
            const freq = baseFreq * (1 + jitter);
            
            state.currentOnsetStart = onset;
            state.targetFreq = freq;
            state.generatedParams[state.currentQuestionIndex] = { onset, freq };
        } else {
            const cached = state.generatedParams[state.currentQuestionIndex];
            state.currentOnsetStart = cached.onset;
            state.targetFreq = cached.freq;
        }

        const noise = ctx.createBufferSource();
        noise.buffer = createNoiseBuffer(ctx);
        noise.loop = true;
        const noiseGain = ctx.createGain();
        noiseGain.gain.value = 0.05;
        noise.connect(noiseGain).connect(masterGain);
        noise.start(t);
        state.nodes.noise = noise;

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = state.targetFreq;
        
        const howlGain = ctx.createGain();
        howlGain.gain.setValueAtTime(0, t);
        howlGain.gain.setValueAtTime(0.001, t + state.currentOnsetStart);
        howlGain.gain.linearRampToValueAtTime(0.2, t + state.currentOnsetStart + RAMP_DURATION);

        osc.connect(howlGain).connect(masterGain);
        osc.start(t);
        state.nodes.osc = osc;

        setupAnalyzer(masterGain);
        state.currentRampDuration = RAMP_DURATION;
        setMode('playing');
        
        startAnalyzerLoop();
        
        requestAnimationFrame(updateTimer);

    // --- Audio File Mode ---
    } else if (currentConfig.type === 'audio') {
        setStatus(`Q${state.currentQuestionIndex + 1}: Loading...`);
        
        try {
            const data = await loadExternalData(currentConfig.path);
            state.currentOnsetStart = data.metadata.onsetStart;
            state.targetFreq = data.metadata.targetFreq;
            
            const source = ctx.createBufferSource();
            source.buffer = data.buffer;
            
            source.connect(masterGain);
            source.start(t);
            state.nodes.source = source;

            setupAnalyzer(masterGain);
            
            setStatus(`Q${state.currentQuestionIndex + 1}: ${currentConfig.id}`);
            state.currentRampDuration = RAMP_DURATION;
            setMode('playing');

            startAnalyzerLoop();

            requestAnimationFrame(updateTimer);

        } catch (e) {
            console.error(e);
            alert("File Load Error. Check Console.");
            return;
        }
    }
}


// --- Game Loop & Logic ---
function updateTimer() {
    if (state.mode !== 'playing') return;
    const elapsed = state.audioCtx.currentTime - state.startTime;
    els.timer.textContent = elapsed.toFixed(3);
    
    const onsetStart = state.currentOnsetStart;
    if (elapsed >= onsetStart + state.currentRampDuration) els.timer.classList.add('text-red-500');
    else if (elapsed >= onsetStart) els.timer.classList.add('text-yellow-400');
    else els.timer.classList.remove('text-red-500', 'text-yellow-400');

    requestAnimationFrame(updateTimer);
}

function handleReaction() {
    if (state.mode !== 'playing') return;
    
    const pressTime = state.audioCtx.currentTime - state.startTime;
    stopAudio(); 

    const onsetStart = state.currentOnsetStart;

    if (pressTime < onsetStart) {
        state.reactionTime = pressTime;
        els.failTime.textContent = pressTime.toFixed(3);
        els.actualOnset.textContent = onsetStart.toFixed(3);
        recordResult(false);
        setMode('fail');
    } else {
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
    
    if (state.currentQuestionIndex >= SCENARIOS.length) {
        if (state.phase === 1) {
            state.phase = 2;
            state.currentQuestionIndex = 0;
            setMode('phase2Start');
        } else {
            alert("テスト終了！全データはコンソールに出力されています。");
            console.log("--- FINAL RESULTS ---");
            console.table(state.results);
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
    state.mode = (mode === 'phase2Start') ? 'idle' : mode; 
    
    Object.values(els.screens).forEach(el => el.classList.add('hidden'));

    if (mode === 'idle') els.screens.idle.classList.remove('hidden');
    else if (mode === 'phase2Start') els.screens.phase2.classList.remove('hidden');
    else if (mode === 'playing') els.screens.playing.classList.remove('hidden');
    else if (mode === 'guessing') els.screens.geq.classList.remove('hidden');
    else if (mode === 'result') els.screens.result.classList.remove('hidden');
    else if (mode === 'fail') els.screens.fail.classList.remove('hidden');

    if (mode === 'playing' && state.phase === 2) {
        els.analyzerContainer.classList.remove('hidden');
    } else {
        els.analyzerContainer.classList.add('hidden');
    }

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
        if (!els.screens.phase2.classList.contains('hidden')) {
             setupQuestion();
             return;
        }
        if (state.mode === 'playing') handleReaction();
        else if (state.mode === 'idle') setupQuestion();
    }
});