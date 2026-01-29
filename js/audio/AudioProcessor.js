/**
 * @typedef {'critical' | 'warning' | 'none'} HowlingLevel
 */

/**
 * @typedef {object} HowlingResult
 * @property {number} bin
 * @property {HowlingLevel} level
 * @property {number} ninosValue
 */

/**
 * AudioProcessor class
 * Optimized for full-spectrum NINOS²-T calculation.
 * This is a modified version for integration into Howling-Detection-Test.
 * It accepts an external AudioContext and source node.
 */
export class AudioProcessor {
    #audioContext;
    #analyser;
    
    /** @type {Float32Array[]} */
    #linearHistory = [];
    #HISTORY_SIZE = 64;

    MIN_DB = -100;
    MAX_DB = 0;
    isAnalyzing = false;

    /**
     * @param {AudioContext} audioContext
     */
    constructor(audioContext) {
        this.#audioContext = audioContext;
        this.#analyser = null;
    }

    /**
     * @param {AudioNode} sourceNode 
     * @param {number} fftSize 
     * @param {number} smoothing 
     */
    start(sourceNode, fftSize, smoothing) {
        if (this.isAnalyzing || !this.#audioContext) return;

        this.#analyser = this.#audioContext.createAnalyser();
        this.#analyser.fftSize = fftSize;
        this.#analyser.smoothingTimeConstant = smoothing;
        this.#analyser.minDecibels = this.MIN_DB;
        this.#analyser.maxDecibels = this.MAX_DB;
        
        this.#linearHistory = [];

        sourceNode.connect(this.#analyser);
        this.isAnalyzing = true;
    }

    stop() {
        // The source node is managed externally, so we just disconnect.
        if (this.#analyser) {
            this.#analyser.disconnect();
        }
        this.#analyser = null;
        this.isAnalyzing = false;
        this.#linearHistory = [];
    }

    /**
     * @returns {Float32Array | null}
     */
    getFrequencyData() {
        if (!this.#analyser) return null;
        const binCount = this.#analyser.frequencyBinCount;
        const dBData = new Float32Array(binCount);
        this.#analyser.getFloatFrequencyData(dBData);
        
        const linearData = new Float32Array(binCount);
        for (let i = 0; i < binCount; i++) {
            linearData[i] = Math.pow(10, dBData[i] / 20);
        }

        this.#linearHistory.push(linearData);
        if (this.#linearHistory.length > this.#HISTORY_SIZE) {
            this.#linearHistory.shift();
        }

        return dBData;
    }

    /**
     * @param {number} alpha 
     * @param {number} states 
     * @param {number} ninosThreshold 
     * @returns {HowlingResult[]}
     */
    detectHowlingFullSpectrum(alpha, states, ninosThreshold) {
        if (this.#linearHistory.length < states) return [];

        const binCount = this.#linearHistory[0].length;
        const currentLinear = this.#linearHistory[this.linearHistory.length - 1];

        let sum = 0;
        let sumSq = 0;
        for (let i = 0; i < binCount; i++) {
            const v = currentLinear[i];
            sum += v;
            sumSq += v * v;
        }
        const mean = sum / binCount;
        const stdDev = Math.sqrt(Math.max(0, (sumSq / binCount) - (mean * mean)));
        const dynamicThreshLinear = mean + alpha * stdDev;

        const nRoot4 = Math.pow(states, 0.25);
        const sparsityDenominator = nRoot4 - 1;

        let maxHdf = -1;
        let maxIdx = -1;

        for (let b = 0; b < binCount; b++) {
            let s2 = 0;
            let s4 = 0;
            
            for (let t = 0; t < states; t++) {
                const v = this.#linearHistory[this.linearHistory.length - 1 - t][b];
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
                maxIdx = b;
            }
        }

        /** @type {HowlingResult[]} */
        const results = [];
        if (maxIdx !== -1) {
            const isNinosExceeded = maxHdf > ninosThreshold;
            const isStatisticallyStrong = currentLinear[maxIdx] > dynamicThreshLinear;

            if (isNinosExceeded && isStatisticallyStrong) {
                results.push({ bin: maxIdx, level: 'critical', ninosValue: maxHdf });
            } else if (isNinosExceeded || isStatisticallyStrong) {
                results.push({ bin: maxIdx, level: 'warning', ninosValue: maxHdf });
            }
        }

        return results;
    }

    getSampleRate() { return this.#audioContext?.sampleRate || 44100; }
    
    /**
     * @param {number} size
     */
    updateFftSize(size) { 
        if (this.#analyser) {
            this.#analyser.fftSize = size;
        }
        this.#linearHistory = []; 
    }

    get fftSize() {
        return this.#analyser?.fftSize;
    }
}
