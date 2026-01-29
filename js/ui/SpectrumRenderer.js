
export class SpectrumRenderer {
    #canvasCtx;
    #canvas;
    #peakValues = null;
    
    #PEAK_LINE_COLOR = 'rgba(255, 255, 100, 0.8)';
    #LINE_COLOR = '#00f2ff';
    #CRITICAL_COLOR = '#ff3333';
    #WARNING_COLOR = '#ffc107';

    /**
     * @param {HTMLCanvasElement} canvas 
     */
    constructor(canvas) {
        this.#canvasCtx = canvas.getContext('2d');
        this.#canvas = canvas;
    }

    #interpolate(v1, v2, fraction) {
        return v1 + (v2 - v1) * fraction;
    }

    #normalizeDb(db, minDb, maxDb) {
        const clamped = Math.max(minDb, Math.min(maxDb, db));
        return (clamped - minDb) / (maxDb - minDb);
    }

    /**
     * @param {Float32Array} dataArray 
     * @param {number} sampleRate 
     * @param {number} minDb 
     * @param {number} maxDb 
     * @param {import('../audio/AudioProcessor.js').HowlingResult[]} howlingResults 
     */
    draw(dataArray, sampleRate, minDb, maxDb, howlingResults) {
        if (!dataArray) return;
        
        // Ensure canvas is visible and sized correctly before drawing
        if (this.#canvas.width !== this.#canvas.clientWidth || this.#canvas.height !== this.#canvas.clientHeight) {
            this.#canvas.width = this.#canvas.clientWidth;
            this.#canvas.height = this.#canvas.clientHeight;
        }
        
        const bufferLength = dataArray.length;
        const width = this.#canvas.width;
        const height = this.#canvas.height;
        const factor = 0.85;

        if (!this.#peakValues || this.#peakValues.length !== bufferLength) {
            this.#peakValues = new Float32Array(bufferLength).fill(minDb);
        }

        for (let i = 0; i < bufferLength; i++) {
            if (dataArray[i] > this.#peakValues[i]) this.#peakValues[i] = dataArray[i];
        }

        this.#canvasCtx.fillStyle = '#111';
        this.#canvasCtx.fillRect(0, 0, width, height);

        this.#drawGrid(width, height, bufferLength, sampleRate, minDb, maxDb);

        const points = [];
        const peakPoints = [];

        for (let x = 0; x <= width; x++) {
            const percent = x / width;
            const logIndex = 1 * Math.pow((bufferLength - 1) / 1, percent);
            const iBase = Math.floor(logIndex);
            const iFrac = logIndex - iBase;

            const val = this.#interpolate(dataArray[iBase], dataArray[iBase+1] || dataArray[iBase], iFrac);
            const normVal = this.#normalizeDb(val, minDb, maxDb);
            
            const result = howlingResults.find(r => Math.abs(r.bin - iBase) <= 1);
            const level = result ? result.level : 'none';
            
            points.push({ x, y: height - (normVal * height * factor), level });

            const pVal = this.#interpolate(this.#peakValues[iBase], this.#peakValues[iBase+1] || this.#peakValues[iBase], iFrac);
            const normPVal = this.#normalizeDb(pVal, minDb, maxDb);
            peakPoints.push({ x, y: height - (normPVal * height * factor) });
        }

        const isCritical = howlingResults.some(r => r.level === 'critical');
        const isWarning = howlingResults.some(r => r.level === 'warning');
        
        // Background Area
        this.#canvasCtx.beginPath();
        const grad = this.#canvasCtx.createLinearGradient(0, 0, 0, height);
        const areaColor = isCritical ? 'rgba(255, 51, 51, 0.3)' : 
                          isWarning ? 'rgba(255, 193, 7, 0.2)' : 'rgba(0, 242, 255, 0.3)';
        
        grad.addColorStop(0, areaColor);
        grad.addColorStop(1, 'transparent');
        this.#canvasCtx.fillStyle = grad;
        this.#canvasCtx.moveTo(0, height);
        points.forEach(p => this.#canvasCtx.lineTo(p.x, p.y));
        this.#canvasCtx.lineTo(width, height);
        this.#canvasCtx.fill();

        // Main Line
        this.#canvasCtx.lineWidth = 2.5;
        for (let i = 0; i < points.length - 1; i++) {
            this.#canvasCtx.beginPath();
            const color = points[i].level === 'critical' ? this.#CRITICAL_COLOR : 
                          points[i].level === 'warning' ? this.#WARNING_COLOR : this.#LINE_COLOR;
            this.#canvasCtx.strokeStyle = color;
            this.#canvasCtx.moveTo(points[i].x, points[i].y);
            this.#canvasCtx.lineTo(points[i+1].x, points[i+1].y);
            this.#canvasCtx.stroke();
        }

        // Peak Line
        this.#canvasCtx.beginPath();
        this.#canvasCtx.strokeStyle = this.#PEAK_LINE_COLOR;
        this.#canvasCtx.lineWidth = 1.5;
        this.#canvasCtx.setLineDash([4, 4]);
        this.#canvasCtx.moveTo(peakPoints[0].x, peakPoints[0].y);
        peakPoints.forEach(p => this.#canvasCtx.lineTo(p.x, p.y));
        this.#canvasCtx.stroke();
        this.#canvasCtx.setLineDash([]);
    }

    #drawGrid(w, h, len, sr, min, max) {
        this.#canvasCtx.strokeStyle = 'rgba(255,255,255,0.08)';
        this.#canvasCtx.fillStyle = 'rgba(255,255,255,0.4)';
        this.#canvasCtx.font = '10px "Segoe UI", Arial';
        [20, 100, 1000, 5000, 10000, 20000].forEach(f => {
            const bin = (f * len * 2) / sr;
            const x = w * Math.log(bin / 1) / Math.log((len - 1) / 1);
            if (x < 0 || x > w) return;
            this.#canvasCtx.beginPath(); this.#canvasCtx.moveTo(x, 0); this.#canvasCtx.lineTo(x, h); this.#canvasCtx.stroke();
            this.#canvasCtx.fillText(f >= 1000 ? (f/1000)+'k' : f+'', x+2, h-5);
        });
        for (let db = max; db >= min; db -= 20) {
            const y = h - ((db - min) / (max - min) * h * 0.85);
            if(y > h) continue;
            this.#canvasCtx.beginPath(); this.#canvasCtx.moveTo(0, y); this.#canvasCtx.lineTo(w, y); this.#canvasCtx.stroke();
            this.#canvasCtx.fillText(db + 'dB', 5, y - 2);
        }
    }

    resetPeaks() { if (this.#peakValues) this.#peakValues.fill(-100); }
    clear() { 
        const width = this.#canvas.width;
        const height = this.#canvas.height;
        this.#canvasCtx.fillStyle = '#111'; 
        this.#canvasCtx.fillRect(0, 0, width, height); 
    }
}
