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
    { id: '2-2', type: 'audio', path: 'assets/Speech/speech_02004' },
    { id: '2-3', type: 'audio', path: 'assets/Speech/speech_03023' },
    { id: '2-4', type: 'audio', path: 'assets/Speech/speech_04011' }, 
    { id: '2-5', type: 'audio', path: 'assets/Speech/speech_05004' },
    // Level 3: Music
    { id: '3-1', type: 'audio', path: 'assets/Music/music_01004' },
    { id: '3-2', type: 'audio', path: 'assets/Music/music_02023' },
    { id: '3-3', type: 'audio', path: 'assets/Music/music_03011' },
    { id: '3-4', type: 'audio', path: 'assets/Music/music_04010' },
    { id: '3-5', type: 'audio', path: 'assets/Music/music_07023' }
];

const RAMP_DURATION = 1.0; 
// キャリブレーションに使用する音声ファイルパス
const CALIBRATION_AUDIO_PATH = 'assets/Music/music_01025.wav'; 

// --- Audio Engine Class ---
class AudioEngine {
    constructor() {
        this.ctx = null;
        this.nodes = {};
        this.fftSize = 2048;
        this.minDb = -100;
        this.maxDb = -10;
        this.peakDecay = 0.5;
        this.historySize = 64;
        this.dynamicThresholdAlpha = 6.0;
        this.ninosThreshold = 0.15;

        // Analysis Data Buffers
        this.analyserData = null;
        this.peakValues = null;
        this.linearHistory = [];
        
        // Calibration
        this.testToneNode = null;
    }

    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    stop() {
        Object.values(this.nodes).forEach(node => {
            try {
                if (node.stop) node.stop();
                node.disconnect();
            } catch(e) {}
        });
        this.nodes = {};
        this.stopTestTone(); 
    }

    get currentTime() {
        return this.ctx ? this.ctx.currentTime : 0;
    }

    get sampleRate() {
        return this.ctx ? this.ctx.sampleRate : 44100;
    }

    createNoiseBuffer() {
        if (!this.ctx) return null;
        const bufferSize = this.ctx.sampleRate * 2;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
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

    // Toggle Test Tone (Modified to use Audio File)
    async toggleTestTone() {
        this.init(); 
        
        if (this.testToneNode) {
            this.stopTestTone();
            return false; // Stopped
        } else {
            try {
                // ファイル読み込み
                const response = await fetch(CALIBRATION_AUDIO_PATH);
                if (!response.ok) throw new Error(`Calibration file not found: ${CALIBRATION_AUDIO_PATH}`);
                const arrayBuffer = await response.arrayBuffer();
                const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);

                const source = this.ctx.createBufferSource();
                source.buffer = audioBuffer;
                source.loop = true;
                
                const gain = this.ctx.createGain();
                gain.gain.value = 0.5; // 音量調整
                
                source.connect(gain).connect(this.ctx.destination);
                source.start();
                this.testToneNode = source;
                return true; // Playing
            } catch (e) {
                console.error(e);
                alert("テスト音声の読み込みに失敗しました。\n" + e.message);
                return false;
            }
        }
    }

    stopTestTone() {
        if (this.testToneNode) {
            try {
                this.testToneNode.stop();
                this.testToneNode.disconnect();
            } catch(e) {}
            this.testToneNode = null;
        }
    }

    setupAnalyzer(sourceNode) {
        if (!this.ctx) return;

        const analyser = this.ctx.createAnalyser();
        analyser.fftSize = this.fftSize;
        analyser.smoothingTimeConstant = 0.8;
        analyser.minDecibels = this.minDb;
        analyser.maxDecibels = this.maxDb;
        
        sourceNode.connect(analyser);
        this.nodes.analyser = analyser;
        
        const bufferLength = analyser.frequencyBinCount;
        this.analyserData = new Float32Array(bufferLength);
        this.peakValues = new Float32Array(bufferLength).fill(this.minDb);
        this.linearHistory = [];
    }

    updateData() {
        const analyser = this.nodes.analyser;
        if (!analyser) return null;

        analyser.getFloatFrequencyData(this.analyserData);

        for (let i = 0; i < this.analyserData.length; i++) {
            const currentDb = this.analyserData[i];
            if (currentDb > this.peakValues[i]) {
                this.peakValues[i] = currentDb; 
            } else {
                this.peakValues[i] -= this.peakDecay; 
                if (this.peakValues[i] < this.minDb) this.peakValues[i] = this.minDb;
            }
        }

        const binCount = this.analyserData.length;
        const linearData = new Float32Array(binCount);
        for (let i = 0; i < binCount; i++) {
            linearData[i] = Math.pow(10, this.analyserData[i] / 20);
        }
        
        this.linearHistory.push(linearData);
        if (this.linearHistory.length > this.historySize) {
            this.linearHistory.shift(); 
        }

        const currentLinear = this.linearHistory[this.linearHistory.length - 1];
        const peakInfo = this.detectHowlingFullSpectrum(this.analyserData, currentLinear);

        return {
            analyserData: this.analyserData,
            peakValues: this.peakValues,
            peakInfo: peakInfo
        };
    }

    detectHowlingFullSpectrum(dbData, linearData) {
        let maxValDb = -Infinity; 
        let maxIndex = 0;

        for(let i = 0; i < dbData.length; i++) {
            if (dbData[i] > maxValDb) {
                maxValDb = dbData[i];
                maxIndex = i;
            }
        }

        let detected = false;
        let level = 'none';
        
        if (this.linearHistory.length < this.historySize) {
            const freq = maxIndex * (this.sampleRate / 2 / dbData.length);
            return { detected: false, freq, maxIndex, maxVal: maxValDb, level: 'none', ninosValue: 0 };
        }

        let dynamicThreshLinear = 0;
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
            dynamicThreshLinear = mean + (this.dynamicThresholdAlpha * stdDev);
        }

        const states = this.linearHistory.length;
        const nRoot4 = Math.pow(states, 0.25);
        const sparsityDenominator = nRoot4 - 1;

        let maxHdf = -1;
        let maxHdfIndex = -1;
        const binCount = dbData.length;

        for (let b = 0; b < binCount; b++) {
            let s2 = 0; 
            let s4 = 0; 
            
            for (let t = 0; t < states; t++) {
                const v = this.linearHistory[t][b];
                const v2 = v * v;
                s2 += v2;
                s4 += v2 * v2;
            }

            const l2 = Math.sqrt(s2);
            if (l2 === 0) continue;

            const l4 = Math.pow(s4, 0.25);
            const sparsity = ((l2 / l4) - 1) / sparsityDenominator;
            const hdf = Math.max(0, sparsity * l2);

            if (hdf > maxHdf) {
                maxHdf = hdf;
                maxHdfIndex = b;
            }
        }

        if (maxHdfIndex !== -1) {
            const isNinosExceeded = maxHdf > this.ninosThreshold;
            const isStatisticallyStrong = linearData[maxHdfIndex] > dynamicThreshLinear;

            if (isNinosExceeded && isStatisticallyStrong) {
                detected = true;
                level = 'critical';
                maxIndex = maxHdfIndex; 
            } else if (isNinosExceeded || isStatisticallyStrong) {
                level = 'warning';
                maxIndex = maxHdfIndex;
            }
        }
        
        if (maxValDb < -80) {
            detected = false;
            level = 'none';
        }

        const freq = maxIndex * (this.sampleRate / 2 / dbData.length);

        return { detected, freq, maxIndex, maxVal: maxValDb, level, ninosValue: maxHdf };
    }
}

// --- State Management ---
const state = {
    mode: 'calibration', 
    phase: 1, 
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
    
    audio: new AudioEngine(),
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
        fail: document.getElementById('screenFail'),
        export: document.getElementById('screenExport'),
        calibration: document.getElementById('screenCalibration')
    },
    analyzerContainer: document.getElementById('analyzerContainer'),
    analyzerCanvas: document.getElementById('analyzerCanvas'),
    detectedFreq: document.getElementById('detectedFreq'),
    detectedFreqVal: document.getElementById('detectedFreqVal'),
    geqContainer: document.getElementById('geqContainer'),
    btnStart: document.getElementById('btnStart'),
    btnStartPhase2: document.getElementById('btnStartPhase2'),
    btnNext: document.getElementById('btnNext'),
    btnNextFail: document.getElementById('btnNextFail'), 
    btnReact: document.getElementById('btnReact'),
    exportData: document.getElementById('exportData'),
    btnCopy: document.getElementById('btnCopy'),
    copyStatus: document.getElementById('copyStatus'),
    btnTestTone: document.getElementById('btnTestTone'),
    btnCalibNext: document.getElementById('btnCalibNext')
};

// --- Helper Functions ---
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

async function loadExternalData(basePath) {
    const csvRes = await fetch(`${basePath}.csv`);
    if (!csvRes.ok) throw new Error(`CSV not found: ${basePath}`);
    const csvText = await csvRes.text();
    const metadata = parseCSV(csvText);
    const wavRes = await fetch(`${basePath}.wav`);
    const arrayBuffer = await wavRes.arrayBuffer();
    const audioBuffer = await state.audio.ctx.decodeAudioData(arrayBuffer); 
    return { buffer: audioBuffer, metadata };
}

// --- Visualization ---
function interpolate(v1, v2, fraction, minDb) {
    if (!isFinite(v1)) v1 = minDb;
    if (!isFinite(v2)) v2 = minDb;
    return v1 + (v2 - v1) * fraction;
}

function normalizeDb(db, minDb, maxDb) {
    return Math.max(0, Math.min(1, (db - minDb) / (maxDb - minDb)));
}

function drawGrid(ctx, w, h, bufferLength, sampleRate, minDb, maxDb) {
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
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
            const label = f >= 1000 ? (f/1000) + 'k' : f;
            ctx.fillText(label, x, h - 2);
        }
    });

    ctx.textAlign = 'left';
    for (let db = maxDb - 10; db > minDb; db -= 20) {
        const normalized = (db - minDb) / (maxDb - minDb);
        const y = h - (normalized * h);
        if (y >= 0 && y <= h) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
            ctx.fillText(db + 'dB', 2, y - 2);
        }
    }
}

function drawSpectrum(data, peakValues, peakInfo, minDb, maxDb) {
    const canvas = els.analyzerCanvas;
    const ctx = canvas.getContext('2d');
    if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
        canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight;
    }
    const width = canvas.width;
    const height = canvas.height;
    const bufferLength = data.length;

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);
    drawGrid(ctx, width, height, bufferLength, state.audio.sampleRate, minDb, maxDb);

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(0, 242, 255, 0.6)');
    gradient.addColorStop(0.5, 'rgba(0, 242, 255, 0.2)');
    gradient.addColorStop(1, 'rgba(0, 242, 255, 0.0)');

    // Fill
    ctx.beginPath(); ctx.moveTo(0, height); 
    for (let x = 0; x <= width; x++) {
        const percent = x / width;
        const logIndex = 1 * Math.pow((bufferLength - 1) / 1, percent);
        const iBase = Math.floor(logIndex); const iFrac = logIndex - iBase;
        const valDb = interpolate(data[iBase], data[iBase + 1], iFrac, minDb);
        const normalizedVal = normalizeDb(valDb, minDb, maxDb);
        ctx.lineTo(x, height - (normalizedVal * height));
    }
    ctx.lineTo(width, height); ctx.closePath(); 
    ctx.fillStyle = gradient; ctx.fill();

    // Stroke
    ctx.beginPath();
    for (let x = 0; x <= width; x++) {
        const percent = x / width;
        const logIndex = 1 * Math.pow((bufferLength - 1) / 1, percent);
        const iBase = Math.floor(logIndex); const iFrac = logIndex - iBase;
        const valDb = interpolate(data[iBase], data[iBase + 1], iFrac, minDb);
        const normalizedVal = normalizeDb(valDb, minDb, maxDb);
        const y = height - (normalizedVal * height);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#00f2ff'; ctx.lineWidth = 2; ctx.stroke();

    // Peak Hold
    if (peakValues) {
        ctx.beginPath();
        for (let x = 0; x <= width; x++) {
            const percent = x / width;
            const logIndex = 1 * Math.pow((bufferLength - 1) / 1, percent);
            const iBase = Math.floor(logIndex); const iFrac = logIndex - iBase;
            const peakDb = interpolate(peakValues[iBase], peakValues[iBase + 1], iFrac, minDb);
            const normalizedPeak = normalizeDb(peakDb, minDb, maxDb);
            const y = height - (normalizedPeak * height);
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'rgba(255, 235, 59, 0.8)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    }

    // Highlight
    if (peakInfo.detected) {
        const safeIndex = Math.max(1, peakInfo.maxIndex); 
        const percent = Math.log(safeIndex) / Math.log(bufferLength - 1);
        const detectedX = width * percent;
        const highlightWidth = 4;
        ctx.fillStyle = peakInfo.level === 'critical' ? 'rgba(255, 50, 50, 0.8)' : 'rgba(255, 193, 7, 0.8)';
        ctx.fillRect(detectedX - highlightWidth/2, 0, highlightWidth, height);
    }
}

function updateAnalyzerUI(peakInfo) {
    if (peakInfo.detected) {
        els.detectedFreq.classList.remove('hidden');
        els.detectedFreqVal.textContent = Math.round(peakInfo.freq);
        els.detectedFreq.style.color = peakInfo.level === 'critical' ? '#ef4444' : '#fbbf24';
    } else {
        els.detectedFreq.classList.add('hidden');
    }
}

// --- Game Logic ---

function startAnalyzerLoop() {
    if (state.phase === 2 && state.mode === 'playing') {
        updateAnalyzerLoop();
    }
}

function updateAnalyzerLoop() {
    if (state.mode !== 'playing') return;
    state.animationId = requestAnimationFrame(updateAnalyzerLoop);
    const result = state.audio.updateData();
    if (!result) return;
    drawSpectrum(result.analyserData, result.peakValues, result.peakInfo, state.audio.minDb, state.audio.maxDb);
    updateAnalyzerUI(result.peakInfo);
}

async function setupQuestion() {
    state.audio.init();
    state.audio.stop();
    if (state.animationId) { cancelAnimationFrame(state.animationId); state.animationId = null; }
    resetUI();

    // Reset Round Data
    state.reactionTime = null;
    state.selectedBand = null;
    state.score = { time: 0, freq: 0, total: 0, distance: 0 };

    const t = state.audio.currentTime;
    state.startTime = t;

    if (state.phase === 1) {
        els.phaseDisplay.textContent = "PHASE 1: Blind Test";
        els.phaseDisplay.className = "bg-gray-800 px-2 py-1 rounded border border-gray-600 text-gray-400";
    } else {
        els.phaseDisplay.textContent = "PHASE 2: Assisted Test";
        els.phaseDisplay.className = "bg-purple-900 px-2 py-1 rounded border border-purple-500 text-purple-200 font-bold";
    }

    if (state.phase === 2) els.analyzerContainer.classList.remove('hidden');
    else els.analyzerContainer.classList.add('hidden');

    const currentConfig = SCENARIOS[state.currentQuestionIndex];
    const ctx = state.audio.ctx;
    const masterGain = ctx.createGain();
    masterGain.gain.value = 0.5;
    masterGain.connect(ctx.destination);
    state.audio.nodes.masterGain = masterGain;
    
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
        noise.buffer = state.audio.createNoiseBuffer();
        noise.loop = true;
        const noiseGain = ctx.createGain();
        noiseGain.gain.value = 0.05;
        noise.connect(noiseGain).connect(masterGain);
        noise.start(t);
        state.audio.nodes.noise = noise;

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = state.targetFreq;
        const howlGain = ctx.createGain();
        howlGain.gain.setValueAtTime(0, t);
        howlGain.gain.setValueAtTime(0.001, t + state.currentOnsetStart);
        howlGain.gain.linearRampToValueAtTime(0.2, t + state.currentOnsetStart + RAMP_DURATION);
        osc.connect(howlGain).connect(masterGain);
        osc.start(t);
        state.audio.nodes.osc = osc;

        state.audio.setupAnalyzer(masterGain);
        state.currentRampDuration = RAMP_DURATION;
        setMode('playing');
        startAnalyzerLoop();
        requestAnimationFrame(updateTimer);

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
            state.audio.nodes.source = source;
            state.audio.setupAnalyzer(masterGain);
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

function updateTimer() {
    if (state.mode !== 'playing') return;
    const elapsed = state.audio.currentTime - state.startTime;
    els.timer.textContent = elapsed.toFixed(3);
    els.timer.className = "text-3xl font-mono text-blue-400";
    requestAnimationFrame(updateTimer);
}

function handleReaction() {
    if (state.mode !== 'playing') return;
    
    const pressTime = state.audio.currentTime - state.startTime;
    state.audio.stop();
    if (state.animationId) { cancelAnimationFrame(state.animationId); state.animationId = null; }

    const onsetStart = state.currentOnsetStart;

    if (pressTime < onsetStart) {
        state.reactionTime = pressTime;
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

    state.score = { time: tScore, freq: fScore, total: Math.round((tScore + fScore) / 2), distance: distance, correctBand: correctBand };

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

function renderExport() {
    const headers = "Phase,QuestionID,Success,ReactionTime,TargetFreq,SelectedBand,Distance";
    const rows = state.results.map(r => {
        const band = r.selectedBand !== null ? r.selectedBand : '';
        const dist = r.success ? r.score.distance : '';
        return `${r.phase},${r.id},${r.success},${r.reactionTime ? r.reactionTime.toFixed(3) : ''},${r.targetFreq.toFixed(1)},${band},${dist}`;
    });
    const csvContent = [headers, ...rows].join('\n');
    
    if (els.exportData) {
        els.exportData.value = csvContent;
    }
}

function nextQuestion() {
    state.currentQuestionIndex++;
    if (state.currentQuestionIndex >= SCENARIOS.length) {
        if (state.phase === 1) {
            state.phase = 2;
            state.currentQuestionIndex = 0;
            setMode('phase2Start');
        } else {
            setMode('export');
            renderExport();
        }
    } else {
        setupQuestion();
    }
}

function setStatus(text) {
    els.status.textContent = text;
}

function setMode(mode) {
    state.mode = (mode === 'phase2Start' || mode === 'export' || mode === 'calibration') ? 'idle' : mode; 
    
    Object.values(els.screens).forEach(el => {
        if(el) el.classList.add('hidden');
    });

    if (mode === 'idle') els.screens.idle.classList.remove('hidden');
    else if (mode === 'calibration') els.screens.calibration.classList.remove('hidden'); 
    else if (mode === 'phase2Start') els.screens.phase2.classList.remove('hidden');
    else if (mode === 'playing') els.screens.playing.classList.remove('hidden');
    else if (mode === 'guessing') els.screens.geq.classList.remove('hidden');
    else if (mode === 'result') els.screens.result.classList.remove('hidden');
    else if (mode === 'fail') els.screens.fail.classList.remove('hidden');
    else if (mode === 'export') els.screens.export.classList.remove('hidden'); 

    if (mode !== 'playing') {
        els.analyzerContainer.classList.add('hidden');
    }

    if (mode === 'calibration') setStatus("SETUP");
    else if (mode === 'phase2Start') setStatus("INTERMISSION");
    else if (mode === 'export') setStatus("COMPLETED");
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
        div.appendChild(track); div.appendChild(label);
        els.geqContainer.appendChild(div);
    });
}

function renderResult() {
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
if (els.btnNextFail) els.btnNextFail.onclick = nextQuestion; 

if (els.btnCopy) {
    els.btnCopy.onclick = () => {
        const textarea = els.exportData;
        textarea.select();
        document.execCommand('copy'); 
        els.copyStatus.textContent = "Copied to clipboard!";
        setTimeout(() => { els.copyStatus.textContent = ""; }, 3000);
    };
}

// Calibration Buttons
if (els.btnTestTone) {
    els.btnTestTone.onclick = async () => {
        els.btnTestTone.disabled = true;
        els.btnTestTone.querySelector('span').textContent = "Loading...";
        
        const isPlaying = await state.audio.toggleTestTone();
        
        els.btnTestTone.disabled = false;
        els.btnTestTone.querySelector('span').textContent = isPlaying ? "Stop Test Tone" : "Play Test Tone";
        els.btnTestTone.classList.toggle('bg-green-600', isPlaying);
        els.btnTestTone.classList.toggle('bg-gray-700', !isPlaying);
    };
}

if (els.btnCalibNext) {
    els.btnCalibNext.onclick = () => {
        state.audio.stopTestTone();
        setMode('idle'); 
    };
}

setMode('calibration');

window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        e.preventDefault();
        if (!els.screens.export.classList.contains('hidden')) return;
        if (!els.screens.calibration.classList.contains('hidden')) return;

        if (!els.screens.phase2.classList.contains('hidden')) {
             setupQuestion();
             return;
        }
        if (state.mode === 'playing') handleReaction();
        else if (state.mode === 'idle') setupQuestion();
    }
});