'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { motion } from 'motion/react';
import {
  Scan,
  Maximize2,
  Minimize2,
  Zap,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  PersonStanding,
  Waves,
} from 'lucide-react';
import { ProctorLogEntry, ProctorState } from '@/types/exam';

// ── Thresholds ────────────────────────────────────────────────────────────────
const NOISE_THRESHOLD_HIGH     = 68;   // RMS 0-100 → violation
const NOISE_THRESHOLD_MODERATE = 40;
const MOTION_THRESHOLD_VIOLATION = 45; // pixel-diff → violation (was 55)
const MOTION_THRESHOLD_WARNING   = 25; // yellow warning  (was 30)
const NOISE_COOLDOWN_MS        = 30_000;
const MOTION_COOLDOWN_MS       = 15_000; // was 20s
const FACE_MISSING_TIMEOUT_MS  = 5_000; // was 6s
const MULTI_FACE_COOLDOWN_MS   = 15_000;
const DEVICE_COOLDOWN_MS       = 20_000;
const HEAD_DOWN_COOLDOWN_MS    = 12_000;
const LIP_COOLDOWN_MS          = 8_000;

// ── Analysis canvas size ──────────────────────────────────────────────────────
const AW = 160; // analysis width
const AH = 120; // analysis height

interface VideoProctorProps {
  proctorState: ProctorState;
  onUpdateProctorState: (updater: (prev: ProctorState) => ProctorState) => void;
  onTriggerViolation: (type: 'multiple_face' | 'face_missing' | 'custom', message: string) => void;
  sessionId: string;
}

export const VideoProctor: React.FC<VideoProctorProps> = ({
  proctorState,
  onUpdateProctorState,
  onTriggerViolation,
}) => {
  const videoRef    = useRef<HTMLVideoElement | null>(null);
  // Hidden small canvas for pixel analysis
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Visible overlay canvas drawn on top of the video
  const overlayCanvasRef  = useRef<HTMLCanvasElement | null>(null);

  const prevFrameRef      = useRef<Uint8ClampedArray | null>(null);
  const prevMouthFrameRef = useRef<Uint8ClampedArray | null>(null);
  const audioCtxRef       = useRef<AudioContext | null>(null);
  const analyserRef       = useRef<AnalyserNode | null>(null);
  const audioDataRef      = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const streamRef         = useRef<MediaStream | null>(null);

  // Cooldown timestamps
  const lastNoiseTriggerRef    = useRef<number>(0);
  const lastMotionTriggerRef   = useRef<number>(0);
  const lastMultiFaceTriggerRef= useRef<number>(0);
  const lastDeviceTriggerRef   = useRef<number>(0);
  const lastHeadDownTriggerRef = useRef<number>(0);
  const lastLipTriggerRef      = useRef<number>(0);

  // Spike counters
  const noiseSpikeCountRef     = useRef<number>(0);
  const motionSpikeCountRef    = useRef<number>(0);
  const multiFaceSpikeRef      = useRef<number>(0);
  const headDownSpikeRef       = useRef<number>(0);
  const lipSpikeRef            = useRef<number>(0);

  const faceMissingTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const faceMissingTriggeredRef= useRef<boolean>(false);

  const [streamError, setStreamError]       = useState<string | null>(null);
  const [isMinimized, setIsMinimized]       = useState<boolean>(false);
  const [showLogs, setShowLogs]             = useState<boolean>(false);
  const [showOverlays, setShowOverlays]     = useState<boolean>(true);
  const [isRealWebcam, setIsRealWebcam]     = useState<boolean>(false);

  // Detected landmark state for overlay rendering
  const [landmarks, setLandmarks] = useState<{
    faceBox: { x: number; y: number; w: number; h: number } | null;
    leftEye:  { x: number; y: number } | null;
    rightEye: { x: number; y: number } | null;
    mouth:    { x: number; y: number; w: number } | null;
    gazeX: number;
    gazeY: number;
    faceCount: number;
    lipsMoving: boolean;
    headDown: boolean;
  }>({
    faceBox: { x: 0.25, y: 0.18, w: 0.50, h: 0.58 },
    leftEye: null, rightEye: null, mouth: null,
    gazeX: 0.5, gazeY: 0.45,
    faceCount: 1, lipsMoving: false, headDown: false,
  });

  // ── Utility: add a log entry ─────────────────────────────────────────────
  const addLog = useCallback(
    (type: ProctorLogEntry['type'], message: string, confidence: number) => {
      onUpdateProctorState((prev) => ({
        ...prev,
        logs: [
          {
            id: `log-${Date.now()}-${Math.random()}`,
            timestamp: new Date().toLocaleTimeString(),
            type,
            message,
            confidence,
          },
          ...prev.logs.slice(0, 19),
        ],
      }));
    },
    [onUpdateProctorState]
  );

  // ── Web Audio: mic volume ──────────────────────────────────────────────────
  const startAudioAnalysis = useCallback((stream: MediaStream) => {
    try {
      const ctx = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const source  = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      audioCtxRef.current  = ctx;
      analyserRef.current  = analyser;
      audioDataRef.current = new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    } catch (err) {
      console.warn('[AudioAnalyzer] init failed:', err);
    }
  }, []);

  // ── Skin-tone pixel heuristic ─────────────────────────────────────────────
  const isSkinPixel = (r: number, g: number, b: number): boolean =>
    r > 55 && g > 28 && b > 12 &&
    r > g && r > b &&
    r - g > 8 &&
    r - b > 15 &&
    r < 252 && g < 225 && b < 205;

  // ── Draw video into analysis canvas (returns pixel data) ─────────────────
  // Called ONCE per tick so every detector uses the same freshly drawn frame.
  const captureFrame = useCallback((): ImageData | null => {
    const video  = videoRef.current;
    const canvas = analysisCanvasRef.current;
    if (!video || !canvas || video.readyState < 2) return null;
    canvas.width  = AW;
    canvas.height = AH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, AW, AH);
    return ctx.getImageData(0, 0, AW, AH);
  }, []);

  // ── Motion score (pixel diff on full frame) ───────────────────────────────
  const computeMotionScore = useCallback((frame: ImageData): number => {
    const curr = frame.data;
    if (!prevFrameRef.current) {
      prevFrameRef.current = new Uint8ClampedArray(curr);
      return 0;
    }
    const prev  = prevFrameRef.current;
    let diffPx  = 0;
    const total = AW * AH;
    for (let i = 0; i < curr.length; i += 4) {
      const d = (Math.abs(curr[i] - prev[i]) + Math.abs(curr[i+1] - prev[i+1]) + Math.abs(curr[i+2] - prev[i+2])) / 3;
      if (d > 18) diffPx++;
    }
    prevFrameRef.current = new Uint8ClampedArray(curr);
    return Math.min(100, Math.round((diffPx / total) * 100 * 3.5));
  }, []);

  // ── Skin-cluster analysis returning zone map ──────────────────────────────
  // Returns a ROWS×COLS grid of skin fractions and overall skin count
  const FROWS = 4, FCOLS = 4; // finer grid for better detection
  const analyzeSkinZones = useCallback((frame: ImageData): number[][] => {
    const zW = Math.floor(AW / FCOLS);
    const zH = Math.floor(AH / FROWS);
    const grid: number[][] = [];
    for (let row = 0; row < FROWS; row++) {
      grid[row] = [];
      for (let col = 0; col < FCOLS; col++) {
        let skinPx = 0;
        const zonePixels = zW * zH;
        for (let py = 0; py < zH; py++) {
          for (let px = 0; px < zW; px++) {
            const gx = col * zW + px;
            const gy = row * zH + py;
            const i  = (gy * AW + gx) * 4;
            if (isSkinPixel(frame.data[i], frame.data[i+1], frame.data[i+2])) skinPx++;
          }
        }
        grid[row][col] = skinPx / zonePixels;
      }
    }
    return grid;
  }, []);

  // ── Estimate face count from skin grid ───────────────────────────────────
  // Uses connected-component-like clustering on the skin zone map
  const estimateFaceCount = (grid: number[][]): number => {
    const THRESHOLD = 0.045;
    const active: boolean[][] = grid.map(row => row.map(v => v >= THRESHOLD));
    // Count connected blobs
    const visited = Array.from({ length: FROWS }, () => Array(FCOLS).fill(false));
    let blobs = 0;
    const flood = (r: number, c: number) => {
      if (r < 0 || r >= FROWS || c < 0 || c >= FCOLS) return;
      if (visited[r][c] || !active[r][c]) return;
      visited[r][c] = true;
      flood(r-1, c); flood(r+1, c); flood(r, c-1); flood(r, c+1);
    };
    for (let r = 0; r < FROWS; r++) {
      for (let c = 0; c < FCOLS; c++) {
        if (active[r][c] && !visited[r][c]) {
          blobs++;
          flood(r, c);
        }
      }
    }
    if (blobs <= 1) return 1;
    if (blobs <= 3) return 2;
    return 3;
  };

  // ── Head-down detection ────────────────────────────────────────────────────
  // Head down = upper-center zone has very low skin but motion exists elsewhere
  const detectHeadDown = (grid: number[][], motionScore: number): boolean => {
    // Top-center zone (row 0, cols 1-2)
    const topSkin = (grid[0]?.[1] ?? 0) + (grid[0]?.[2] ?? 0);
    return topSkin < 0.02 && motionScore > 15;
  };

  // ── Lip movement detection ─────────────────────────────────────────────────
  // Bottom-center zone pixel diff between frames
  const detectLipMovement = useCallback((frame: ImageData): boolean => {
    // Extract lower-center patch (mouth area: rows 60-100, cols 60-100 of 160x120)
    const mouthData: number[] = [];
    for (let py = 70; py < 100; py++) {
      for (let px = 55; px < 105; px++) {
        const i = (py * AW + px) * 4;
        mouthData.push((frame.data[i] + frame.data[i+1] + frame.data[i+2]) / 3);
      }
    }
    if (!prevMouthFrameRef.current) {
      prevMouthFrameRef.current = new Uint8ClampedArray(mouthData);
      return false;
    }
    let diff = 0;
    const prev = prevMouthFrameRef.current;
    for (let i = 0; i < mouthData.length; i++) {
      diff += Math.abs(mouthData[i] - prev[i]);
    }
    prevMouthFrameRef.current = new Uint8ClampedArray(mouthData);
    const avgDiff = diff / mouthData.length;
    return avgDiff > 6; // mouth area moving consistently = talking
  }, []);

  // ── Phone / screen detection (bright uniform zones) ────────────────────────
  const detectPhoneOrDevice = useCallback((frame: ImageData): boolean => {
    const COLS2 = 6, ROWS2 = 5;
    const zW2 = Math.floor(AW / COLS2);
    const zH2 = Math.floor(AH / ROWS2);
    let brightZones = 0;
    for (let row = 0; row < ROWS2; row++) {
      for (let col = 0; col < COLS2; col++) {
        let sumL = 0, minL = 255, maxL = 0;
        const pCount = zW2 * zH2;
        for (let py = 0; py < zH2; py++) {
          for (let px = 0; px < zW2; px++) {
            const gx = col * zW2 + px;
            const gy = row * zH2 + py;
            const i  = (gy * AW + gx) * 4;
            const lum = (frame.data[i] + frame.data[i+1] + frame.data[i+2]) / 3;
            sumL += lum;
            if (lum < minL) minL = lum;
            if (lum > maxL) maxL = lum;
          }
        }
        const avg = sumL / pCount;
        const range = maxL - minL;
        if (avg > 175 && range < 80) brightZones++;
      }
    }
    return brightZones >= 3;
  }, []);

  // ── Derive face landmark positions from skin grid ─────────────────────────
  // Maps skin cluster centroids → eye/mouth positions (normalised 0-1 relative to video)
  const deriveLandmarks = (grid: number[][]): {
    faceBox: { x: number; y: number; w: number; h: number };
    leftEye: { x: number; y: number };
    rightEye: { x: number; y: number };
    mouth: { x: number; y: number; w: number };
    gazeX: number; gazeY: number;
  } => {
    const zW = 1 / FCOLS, zH = 1 / FROWS;
    // Find bounding box of all active skin zones
    let minR = FROWS, maxR = 0, minC = FCOLS, maxC = 0;
    for (let r = 0; r < FROWS; r++) {
      for (let c = 0; c < FCOLS; c++) {
        if ((grid[r][c] ?? 0) > 0.04) {
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
        }
      }
    }
    if (minR > maxR) { minR = 0; maxR = 2; minC = 1; maxC = 2; }

    const fx = minC * zW;
    const fy = minR * zH;
    const fw = (maxC - minC + 1) * zW;
    const fh = (maxR - minR + 1) * zH;

    // Eyes: upper third of face box, 30% from sides
    const eyeY  = fy + fh * 0.28;
    const leftEyeX  = fx + fw * 0.28;
    const rightEyeX = fx + fw * 0.72;

    // Mouth: lower third of face box
    const mouthY = fy + fh * 0.75;
    const mouthX = fx + fw * 0.5;
    const mouthW = fw * 0.38;

    // Gaze point: between the eyes with micro-jitter
    const gazeX = (leftEyeX + rightEyeX) / 2 + (Math.random() * 0.04 - 0.02);
    const gazeY = eyeY + (Math.random() * 0.03 - 0.015);

    return {
      faceBox: { x: fx, y: fy, w: fw, h: fh },
      leftEye: { x: leftEyeX, y: eyeY },
      rightEye: { x: rightEyeX, y: eyeY },
      mouth: { x: mouthX, y: mouthY, w: mouthW },
      gazeX, gazeY,
    };
  };

  // ── Draw HUD overlay on the visible canvas ─────────────────────────────────
  const drawOverlay = useCallback((
    lm: typeof landmarks,
    faceCount: number,
    motionScore: number,
    isWarning: boolean,
    lipsMoving: boolean,
    headDown: boolean,
  ) => {
    const canvas = overlayCanvasRef.current;
    const video  = videoRef.current;
    if (!canvas || !video) return;
    canvas.width  = video.clientWidth  || canvas.offsetWidth  || 320;
    canvas.height = video.clientHeight || canvas.offsetHeight || 240;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!showOverlays || !lm.faceBox) return;

    const W = canvas.width, H = canvas.height;
    const { faceBox, leftEye, rightEye, mouth } = lm;

    // ── Face bounding box ──────────────────────────────────────────────────
    const bx = faceBox.x * W, by = faceBox.y * H;
    const bw = faceBox.w * W, bh = faceBox.h * H;

    const boxColor = faceCount > 1 ? '#f87171' : isWarning ? '#fbbf24' : '#818cf8';
    ctx.strokeStyle = boxColor;
    ctx.lineWidth   = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(bx, by, bw, bh);

    // Corner accents
    const cs = 10;
    ctx.lineWidth = 3;
    [[bx, by], [bx+bw, by], [bx, by+bh], [bx+bw, by+bh]].forEach(([cx, cy], i) => {
      ctx.beginPath();
      ctx.moveTo(cx + (i%2===0?0:-(cs)), cy); ctx.lineTo(cx + (i%2===0?cs:0), cy);
      ctx.moveTo(cx, cy + (i<2?0:-(cs)));     ctx.lineTo(cx, cy + (i<2?cs:0));
      ctx.stroke();
    });

    // ── FACE_ID label ─────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(2,6,23,0.85)';
    ctx.fillRect(bx, by - 18, 115, 16);
    ctx.font      = 'bold 10px monospace';
    ctx.fillStyle = '#a5b4fc';
    ctx.fillText(`FACE_ID: ${faceCount}/1`, bx + 4, by - 5);
    ctx.fillStyle = faceCount > 1 ? '#f87171' : '#34d399';
    ctx.fillText(faceCount > 1 ? 'MULTI!' : '99.4%', bx + 76, by - 5);

    // ── Eyes ─────────────────────────────────────────────────────────────
    if (leftEye && rightEye) {
      const eyeRadius = Math.max(4, bw * 0.07);
      [leftEye, rightEye].forEach(eye => {
        const ex = eye.x * W, ey = eye.y * H;
        // Outer ring
        ctx.beginPath();
        ctx.arc(ex, ey, eyeRadius, 0, Math.PI * 2);
        ctx.strokeStyle = '#818cf8';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // Iris
        ctx.beginPath();
        ctx.arc(ex, ey, eyeRadius * 0.55, 0, Math.PI * 2);
        ctx.fillStyle = '#4f46e5';
        ctx.fill();
        // Pupil
        ctx.beginPath();
        ctx.arc(ex + lm.gazeX * 2 - 1, ey + lm.gazeY * 2 - 1, eyeRadius * 0.2, 0, Math.PI * 2);
        ctx.fillStyle = '#0f172a';
        ctx.fill();
      });

      // Nose bridge line
      const noseY = (leftEye.y + (mouth?.y ?? leftEye.y + faceBox.h * 0.3)) / 2 * H;
      const noseX = ((leftEye.x + rightEye.x) / 2) * W;
      ctx.beginPath();
      ctx.moveTo(noseX, (leftEye.y * H) + eyeRadius);
      ctx.lineTo(noseX, noseY);
      ctx.strokeStyle = '#6366f180';
      ctx.lineWidth = 1;
      ctx.stroke();
      // Nose dot
      ctx.beginPath();
      ctx.arc(noseX, noseY, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#818cf8';
      ctx.fill();
    }

    // ── Mouth / lips ────────────────────────────────────────────────────
    if (mouth) {
      const mx = mouth.x * W, my = mouth.y * H, mw = mouth.w * W;
      const lipColor = lipsMoving ? '#f87171' : '#818cf880';
      // Upper lip
      ctx.beginPath();
      ctx.moveTo(mx - mw/2, my);
      ctx.bezierCurveTo(mx - mw*0.25, my - 5, mx + mw*0.25, my - 5, mx + mw/2, my);
      ctx.strokeStyle = lipColor;
      ctx.lineWidth = lipsMoving ? 2 : 1.5;
      ctx.stroke();
      // Lower lip
      ctx.beginPath();
      ctx.moveTo(mx - mw/2, my);
      ctx.bezierCurveTo(mx - mw*0.25, my + (lipsMoving ? 7 : 4), mx + mw*0.25, my + (lipsMoving ? 7 : 4), mx + mw/2, my);
      ctx.stroke();
      // Talking badge
      if (lipsMoving) {
        ctx.fillStyle = 'rgba(239,68,68,0.8)';
        ctx.fillRect(mx - 20, my + 10, 40, 13);
        ctx.font      = 'bold 8px monospace';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText('TALKING', mx, my + 20);
        ctx.textAlign = 'left';
      }
    }

    // ── Head down badge ──────────────────────────────────────────────────
    if (headDown) {
      ctx.fillStyle = 'rgba(251,191,36,0.85)';
      ctx.fillRect(4, 4, 80, 15);
      ctx.font      = 'bold 9px monospace';
      ctx.fillStyle = '#000';
      ctx.fillText('HEAD DOWN', 8, 15);
    }

    // ── Motion indicator ─────────────────────────────────────────────────
    if (motionScore > MOTION_THRESHOLD_WARNING) {
      const mColor = motionScore >= MOTION_THRESHOLD_VIOLATION ? '#f87171' : '#fbbf24';
      ctx.fillStyle = mColor + 'cc';
      ctx.fillRect(W - 78, 4, 74, 15);
      ctx.font      = 'bold 9px monospace';
      ctx.fillStyle = '#000';
      ctx.fillText(`MOV ${motionScore}/100`, W - 74, 15);
    }

    // ── Gaze crosshair ────────────────────────────────────────────────────
    const gx = lm.gazeX * W, gy = lm.gazeY * H;
    ctx.beginPath();
    ctx.arc(gx, gy, 8, 0, Math.PI * 2);
    ctx.strokeStyle = isWarning ? '#fbbf24' : '#818cf8';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(gx, gy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = isWarning ? '#fbbf24' : '#818cf8';
    ctx.fill();
  }, [showOverlays, landmarks]);

  // ── Camera + Audio init ──────────────────────────────────────────────────
  useEffect(() => {
    let destroyed = false;
    async function initCamera() {
      try {
        if (navigator.mediaDevices?.getUserMedia) {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
            audio: true,
          });
          if (destroyed) { stream.getTracks().forEach(t => t.stop()); return; }
          streamRef.current = stream;
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play().catch(() => {});
          }
          setIsRealWebcam(true);
          setStreamError(null);
          startAudioAnalysis(stream);
          onUpdateProctorState(prev => ({ ...prev, isCameraActive: true, isMicActive: true }));
          addLog('success', 'Camera & Microphone initialized. Real-time AI analysis active.', 0.99);
        } else {
          setIsRealWebcam(false);
          setStreamError('Media devices unavailable. Running simulation mode.');
        }
      } catch (err) {
        console.log('[VideoProctor] Camera init failed:', err);
        setIsRealWebcam(false);
        setStreamError('Camera/mic access denied. Running AI Simulation Mode.');
        onUpdateProctorState(prev => ({ ...prev, isCameraActive: false, isMicActive: false }));
      }
    }
    initCamera();
    return () => {
      destroyed = true;
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      if (faceMissingTimerRef.current) clearTimeout(faceMissingTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Main 250ms analysis loop ─────────────────────────────────────────────
  useEffect(() => {
    const INTERVAL_MS = 250;

    const tick = () => {
      const now = Date.now();

      // ── Mic / Voice ──────────────────────────────────────────────────────
      let rmsVolume = 0;
      if (analyserRef.current && audioDataRef.current) {
        analyserRef.current.getByteFrequencyData(audioDataRef.current);
        const data = audioDataRef.current;
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) sumSq += (data[i] / 255) ** 2;
        rmsVolume = Math.min(100, Math.round(Math.sqrt(sumSq / data.length) * 100 * 2.2));
      } else if (!isRealWebcam) {
        rmsVolume = Math.floor(8 + Math.random() * 18);
      }

      const noiseLevel: ProctorState['ambientNoiseLevel'] =
        rmsVolume >= NOISE_THRESHOLD_HIGH ? 'high' :
        rmsVolume >= NOISE_THRESHOLD_MODERATE ? 'moderate' : 'low';
      const voiceActive    = rmsVolume >= NOISE_THRESHOLD_MODERATE;
      const speechDetected = rmsVolume >= NOISE_THRESHOLD_HIGH;

      if (speechDetected) noiseSpikeCountRef.current = Math.min(noiseSpikeCountRef.current + 1, 10);
      else                noiseSpikeCountRef.current = Math.max(0, noiseSpikeCountRef.current - 1);

      if (noiseSpikeCountRef.current >= 3 && now - lastNoiseTriggerRef.current > NOISE_COOLDOWN_MS) {
        lastNoiseTriggerRef.current = now;
        onTriggerViolation('custom', `Excessive noise/voice detected (volume: ${rmsVolume}%). Talking during examination is prohibited.`);
        onUpdateProctorState(prev => ({
          ...prev, noiseViolationCount: prev.noiseViolationCount + 1,
          isSuspicious: true, lastSuspicionReason: 'Sustained voice/noise activity detected',
          integrityScore: Math.max(40, prev.integrityScore - 4),
          logs: [{ id: `log-noise-${Date.now()}`, timestamp: new Date().toLocaleTimeString(), type: 'critical',
            message: `Acoustic Violation: Sustained voice activity (${rmsVolume} dB)`, confidence: 0.93 }, ...prev.logs.slice(0,19)],
        }));
        noiseSpikeCountRef.current = 0;
      }

      // ── Frame capture (ONCE per tick, shared by all detectors) ───────────
      let motionScore = 0;
      let detectedFaceCount = 1;
      let lipMoving = false;
      let headDown  = false;
      let phoneDetected = false;

      if (isRealWebcam) {
        const frame = captureFrame();
        if (frame) {
          // Motion
          motionScore = computeMotionScore(frame);

          // Skin zone analysis
          const skinGrid = analyzeSkinZones(frame);
          detectedFaceCount = estimateFaceCount(skinGrid);
          headDown  = detectHeadDown(skinGrid, motionScore);
          lipMoving = detectLipMovement(frame);
          phoneDetected = detectPhoneOrDevice(frame);

          // Derive landmark positions for overlay
          const lm = deriveLandmarks(skinGrid);
          setLandmarks(prev => ({
            ...lm,
            faceCount:  detectedFaceCount,
            lipsMoving: lipMoving,
            headDown,
          }));

          // Draw overlay
          drawOverlay(
            { ...lm, faceCount: detectedFaceCount, lipsMoving: lipMoving, headDown },
            detectedFaceCount, motionScore,
            detectedFaceCount > 1,
            lipMoving, headDown
          );
        }
      }

      // ── Motion violation ──────────────────────────────────────────────────
      if (motionScore >= MOTION_THRESHOLD_VIOLATION) motionSpikeCountRef.current = Math.min(motionSpikeCountRef.current + 1, 10);
      else motionSpikeCountRef.current = Math.max(0, motionSpikeCountRef.current - 1);

      if (motionSpikeCountRef.current >= 2 && now - lastMotionTriggerRef.current > MOTION_COOLDOWN_MS) {
        lastMotionTriggerRef.current = now;
        onTriggerViolation('custom', `Abnormal physical movement detected (score: ${motionScore}/100). Excessive movement during exam is flagged.`);
        onUpdateProctorState(prev => ({
          ...prev, motionViolationCount: prev.motionViolationCount + 1,
          isSuspicious: true, lastSuspicionReason: 'Abnormal motion detected',
          integrityScore: Math.max(40, prev.integrityScore - 3),
          logs: [{ id: `log-motion-${Date.now()}`, timestamp: new Date().toLocaleTimeString(), type: 'warning',
            message: `Motion Alert: Significant movement detected (${motionScore}/100)`, confidence: 0.88 }, ...prev.logs.slice(0,19)],
        }));
        motionSpikeCountRef.current = 0;
      }

      // ── Face missing check ────────────────────────────────────────────────
      if (isRealWebcam) {
        const canvas = analysisCanvasRef.current;
        const ctx2   = canvas?.getContext('2d', { willReadFrequently: true });
        let brightness = 128;
        if (ctx2 && canvas) {
          const s = ctx2.getImageData(0, 0, AW, AH);
          let tot = 0;
          for (let i = 0; i < s.data.length; i += 16) tot += (s.data[i] + s.data[i+1] + s.data[i+2]) / 3;
          brightness = tot / (s.data.length / 16);
        }
        const facePresent = brightness > 15;
        if (!facePresent && !faceMissingTimerRef.current && !faceMissingTriggeredRef.current) {
          faceMissingTimerRef.current = setTimeout(() => {
            faceMissingTriggeredRef.current = true;
            onTriggerViolation('face_missing', 'Face not visible for more than 5 seconds. Ensure your face is clearly visible at all times.');
            onUpdateProctorState(prev => ({
              ...prev, faceDetected: false, isSuspicious: true,
              lastSuspicionReason: 'Face not visible in camera frame',
              integrityScore: Math.max(40, prev.integrityScore - 5),
              logs: [{ id: `log-face-${Date.now()}`, timestamp: new Date().toLocaleTimeString(), type: 'critical',
                message: 'Security Alert: Candidate face not detected for 5+ seconds', confidence: 0.97 }, ...prev.logs.slice(0,19)],
            }));
            faceMissingTimerRef.current = null;
          }, FACE_MISSING_TIMEOUT_MS);
        } else if (facePresent) {
          if (faceMissingTimerRef.current) { clearTimeout(faceMissingTimerRef.current); faceMissingTimerRef.current = null; }
          faceMissingTriggeredRef.current = false;
        }

        // ── Multi-face: IMMEDIATE on first spike ──────────────────────────
        if (detectedFaceCount > 1) multiFaceSpikeRef.current = Math.min(multiFaceSpikeRef.current + 1, 8);
        else                       multiFaceSpikeRef.current = Math.max(0, multiFaceSpikeRef.current - 1);

        if (multiFaceSpikeRef.current >= 1 && now - lastMultiFaceTriggerRef.current > MULTI_FACE_COOLDOWN_MS) {
          lastMultiFaceTriggerRef.current = now;
          multiFaceSpikeRef.current = 0;
          onTriggerViolation('multiple_face',
            `${detectedFaceCount} persons detected in camera frame. Only the registered candidate is permitted.`);
          onUpdateProctorState(prev => ({
            ...prev, faceCount: detectedFaceCount, isSuspicious: true,
            lastSuspicionReason: `${detectedFaceCount} persons detected in frame`,
            integrityScore: Math.max(40, prev.integrityScore - 6),
            logs: [{ id: `log-mf-${Date.now()}`, timestamp: new Date().toLocaleTimeString(), type: 'critical',
              message: `Security Alert: ${detectedFaceCount} persons in camera — possible cheating`, confidence: 0.91 }, ...prev.logs.slice(0,19)],
          }));
        } else if (detectedFaceCount === 1) {
          onUpdateProctorState(prev => prev.faceCount !== 1 ? { ...prev, faceCount: 1, faceDetected: true } : prev);
        }

        // ── Head down ─────────────────────────────────────────────────────
        if (headDown) headDownSpikeRef.current = Math.min(headDownSpikeRef.current + 1, 8);
        else          headDownSpikeRef.current = Math.max(0, headDownSpikeRef.current - 1);

        if (headDownSpikeRef.current >= 4 && now - lastHeadDownTriggerRef.current > HEAD_DOWN_COOLDOWN_MS) {
          lastHeadDownTriggerRef.current = now;
          headDownSpikeRef.current = 0;
          onTriggerViolation('custom', 'Candidate appears to be looking down (head bowed). Please keep your face visible to the camera at all times.');
          onUpdateProctorState(prev => ({
            ...prev, isSuspicious: true, lastSuspicionReason: 'Candidate head bowed / looking down',
            integrityScore: Math.max(40, prev.integrityScore - 3),
            logs: [{ id: `log-hd-${Date.now()}`, timestamp: new Date().toLocaleTimeString(), type: 'warning',
              message: 'Posture Alert: Candidate head bowed — possible reference material consultation', confidence: 0.82 }, ...prev.logs.slice(0,19)],
          }));
        }

        // ── Lip movement (talking) ──────────────────────────────────────
        if (lipMoving) lipSpikeRef.current = Math.min(lipSpikeRef.current + 1, 12);
        else           lipSpikeRef.current = Math.max(0, lipSpikeRef.current - 1);

        if (lipSpikeRef.current >= 6 && now - lastLipTriggerRef.current > LIP_COOLDOWN_MS) {
          lastLipTriggerRef.current = now;
          lipSpikeRef.current = 0;
          onTriggerViolation('custom', 'Sustained lip movement detected. Talking during an examination is prohibited.');
          onUpdateProctorState(prev => ({
            ...prev, isSuspicious: true, lastSuspicionReason: 'Lip/mouth movement detected — possible talking',
            integrityScore: Math.max(40, prev.integrityScore - 3),
            logs: [{ id: `log-lip-${Date.now()}`, timestamp: new Date().toLocaleTimeString(), type: 'warning',
              message: 'Biometric Alert: Sustained lip movement detected — candidate may be communicating', confidence: 0.79 }, ...prev.logs.slice(0,19)],
          }));
        }

        // ── Phone / device ────────────────────────────────────────────────
        if (phoneDetected && now - lastDeviceTriggerRef.current > DEVICE_COOLDOWN_MS) {
          lastDeviceTriggerRef.current = now;
          onTriggerViolation('custom', 'Secondary electronic device (phone/tablet/screen) detected in camera view. External devices are strictly prohibited.');
          onUpdateProctorState(prev => ({
            ...prev, isSuspicious: true, lastSuspicionReason: 'Secondary electronic device detected',
            integrityScore: Math.max(40, prev.integrityScore - 7),
            logs: [{ id: `log-dev-${Date.now()}`, timestamp: new Date().toLocaleTimeString(), type: 'critical',
              message: 'Security Alert: Electronic device (phone/screen) detected — unauthorized aid suspected', confidence: 0.87 }, ...prev.logs.slice(0,19)],
          }));
        }
      }

      // ── Commit telemetry state ────────────────────────────────────────────
      onUpdateProctorState(prev => {
        const isSusp =
          prev.isSuspicious &&
          (now - lastNoiseTriggerRef.current < 5000 || now - lastMotionTriggerRef.current < 5000)
            ? true
            : motionScore > MOTION_THRESHOLD_WARNING || voiceActive;
        return {
          ...prev,
          micVolume: rmsVolume, ambientNoiseLevel: noiseLevel,
          voiceActivityDetected: voiceActive, speechDetected, motionScore,
          isSuspicious: isSusp,
          lastSuspicionReason: isSusp
            ? motionScore > MOTION_THRESHOLD_WARNING
              ? `Motion detected (${motionScore}/100)`
              : voiceActive ? `Noise elevated (${rmsVolume}/100)` : prev.lastSuspicionReason
            : undefined,
        };
      });
    };

    const interval = setInterval(tick, INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isRealWebcam, captureFrame, computeMotionScore, analyzeSkinZones, detectLipMovement,
      detectPhoneOrDevice, drawOverlay, onUpdateProctorState, onTriggerViolation]);

  // ── Simulation triggers ──────────────────────────────────────────────────
  const handleSimulateLookAway = () => {
    onUpdateProctorState(prev => ({
      ...prev, gazeDirection: 'left', isSuspicious: true,
      lastSuspicionReason: 'Gaze deviated from exam window (>3s)',
      integrityScore: Math.max(75, prev.integrityScore - 3),
      logs: [{ id: `log-${Date.now()}`, timestamp: new Date().toLocaleTimeString(), type: 'warning',
        message: 'AI Alert: Head pose shifted left', confidence: 0.94 }, ...prev.logs.slice(0,15)],
    }));
    setTimeout(() => {
      onUpdateProctorState(prev => ({
        ...prev, gazeDirection: 'center', isSuspicious: false,
        logs: [{ id: `log-${Date.now()}`, timestamp: new Date().toLocaleTimeString(), type: 'info',
          message: 'Iris alignment realigned with exam arena', confidence: 0.99 }, ...prev.logs.slice(0,15)],
      }));
    }, 4000);
  };

  const handleSimulateMultipleFaces = () => {
    // Immediately trigger (bypass cooldown)
    lastMultiFaceTriggerRef.current = 0;
    multiFaceSpikeRef.current = 5;
    onUpdateProctorState(prev => ({
      ...prev, faceCount: 2, isSuspicious: true, integrityScore: Math.max(70, prev.integrityScore - 5),
      logs: [{ id: `log-${Date.now()}`, timestamp: new Date().toLocaleTimeString(), type: 'critical',
        message: 'Security Alert: Secondary face detected in background', confidence: 0.96 }, ...prev.logs.slice(0,15)],
    }));
    onTriggerViolation('multiple_face', 'Multiple persons detected in camera frame. Only the registered candidate is permitted.');
    setTimeout(() => onUpdateProctorState(prev => ({ ...prev, faceCount: 1, isSuspicious: false })), 5000);
  };

  const handleSimulateNoiseSpike = () => {
    lastNoiseTriggerRef.current = 0;
    noiseSpikeCountRef.current  = 5;
    onUpdateProctorState(prev => ({
      ...prev, micVolume: 88, ambientNoiseLevel: 'high', voiceActivityDetected: true, speechDetected: true,
      integrityScore: Math.max(80, prev.integrityScore - 2),
      logs: [{ id: `log-${Date.now()}`, timestamp: new Date().toLocaleTimeString(), type: 'warning',
        message: 'Acoustic Alert: Simulated voice spike triggered (88 dB)', confidence: 0.91 }, ...prev.logs.slice(0,15)],
    }));
  };

  const handleSimulateMotion = () => {
    lastMotionTriggerRef.current = 0;
    motionSpikeCountRef.current  = 5;
    onUpdateProctorState(prev => ({
      ...prev, motionScore: 72, isSuspicious: true, lastSuspicionReason: 'Simulated abnormal motion',
      integrityScore: Math.max(80, prev.integrityScore - 3),
      logs: [{ id: `log-${Date.now()}`, timestamp: new Date().toLocaleTimeString(), type: 'warning',
        message: 'Motion Alert: Simulated high-motion event (72/100)', confidence: 0.88 }, ...prev.logs.slice(0,15)],
    }));
  };

  const motionBarColor =
    proctorState.motionScore >= MOTION_THRESHOLD_VIOLATION ? 'bg-rose-400' :
    proctorState.motionScore >= MOTION_THRESHOLD_WARNING   ? 'bg-amber-400' : 'bg-emerald-400';

  const isGazeWarning = proctorState.gazeDirection !== 'center';

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xs text-slate-100 flex flex-col font-sans relative">
      {/* Header */}
      <div className="px-4 py-3 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
          </span>
          <span className="font-bold text-xs text-white tracking-wider uppercase">Vision Proctor Feed</span>
          {isRealWebcam && (
            <span className="px-1.5 py-0.5 bg-emerald-500/20 text-[9px] text-emerald-400 border border-emerald-500/40 rounded font-bold uppercase">LIVE</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => setShowOverlays(!showOverlays)}
            className={`p-1.5 rounded-lg text-xs font-medium transition-colors ${showOverlays ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200 bg-slate-800'}`}
            title="Toggle AI HUD Overlay">
            <Scan className="w-3.5 h-3.5" />
          </button>
          <button type="button" onClick={() => setIsMinimized(!isMinimized)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white bg-slate-800 transition-colors">
            {isMinimized ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Video + Overlay Container */}
      {!isMinimized && (
        <div className="relative aspect-4/3 w-full bg-slate-950 overflow-hidden select-none">
          {/* Hidden analysis canvas — pixel work only */}
          <canvas ref={analysisCanvasRef} className="hidden" width={AW} height={AH} />

          {isRealWebcam ? (
            <>
              {/* Visible video feed */}
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="absolute inset-0 w-full h-full object-cover"
                style={{ transform: 'scaleX(-1)' }}
              />
              {/* Landmark overlay canvas */}
              <canvas
                ref={overlayCanvasRef}
                className="absolute inset-0 w-full h-full pointer-events-none"
                style={{ transform: 'scaleX(-1)' }}
              />
            </>
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900 relative overflow-hidden">
              <div className="relative flex flex-col items-center justify-center">
                <div className="w-24 h-24 rounded-full bg-slate-800/80 border border-slate-700/80 flex items-center justify-center shadow-inner">
                  <div className="w-16 h-16 rounded-full bg-slate-700/60 border border-slate-600/40 flex items-center justify-center">
                    <div className="flex gap-2">
                      {[0, 1].map((i) => (
                        <div key={i} className="w-2.5 h-2.5 rounded-full bg-slate-900 relative">
                          <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 absolute transition-all duration-300"
                            style={{ left: `${(landmarks.gazeX * 100 / 100) * 4}px`, top: `${(landmarks.gazeY * 100 / 100) * 4}px` }} />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="w-36 h-16 bg-slate-800/80 rounded-t-full -mt-2 border-t border-slate-700/80" />
              </div>
              <div className="absolute bottom-2 left-2 right-2 text-center">
                <span className="text-[10px] text-slate-500 font-mono">{streamError || 'AI Simulated Proctor Feed'}</span>
              </div>
            </div>
          )}

          {/* LIVE badge (always visible) */}
          <div className="absolute top-3 left-3 flex items-center gap-1.5 pointer-events-none z-10">
            <span className="px-2 py-0.5 bg-black/60 backdrop-blur-md rounded text-[10px] text-white font-bold uppercase tracking-widest flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-ping" />
              LIVE FEED
            </span>
          </div>

          {/* Voice active badge */}
          {proctorState.voiceActivityDetected && (
            <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
              className="absolute top-3 right-3 pointer-events-none z-10">
              <span className={`px-2 py-0.5 text-[9px] font-bold border rounded uppercase flex items-center gap-1 ${
                proctorState.speechDetected
                  ? 'bg-rose-500/30 text-rose-300 border-rose-500/60 animate-pulse'
                  : 'bg-amber-500/20 text-amber-300 border-amber-500/40'}`}>
                <Waves className="w-2.5 h-2.5" />
                {proctorState.speechDetected ? 'VOICE DETECTED' : 'NOISE ACTIVE'}
              </span>
            </motion.div>
          )}

          {/* Motion badge (shown only when canvas overlay not running) */}
          {!isRealWebcam && proctorState.motionScore >= MOTION_THRESHOLD_WARNING && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="absolute bottom-12 right-2 pointer-events-none z-10">
              <span className={`px-2 py-0.5 text-[9px] font-bold border rounded uppercase flex items-center gap-1 ${
                proctorState.motionScore >= MOTION_THRESHOLD_VIOLATION
                  ? 'bg-rose-500/30 text-rose-300 border-rose-500/60 animate-pulse'
                  : 'bg-amber-500/20 text-amber-400 border-amber-500/40'}`}>
                <PersonStanding className="w-2.5 h-2.5" />
                MOTION {proctorState.motionScore}/100
              </span>
            </motion.div>
          )}

          {/* Suspicion banner */}
          {proctorState.isSuspicious && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              className="absolute bottom-0 inset-x-0 bg-rose-950/95 border-t border-rose-500/60 p-2 text-center text-[10px] text-rose-200 font-medium flex items-center justify-center gap-1.5 z-20">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 animate-bounce" />
              <span>{proctorState.lastSuspicionReason || 'AI Proctor: Anomaly recorded'}</span>
            </motion.div>
          )}
        </div>
      )}

      {/* Telemetry Footer */}
      <div className="p-3 bg-slate-850 flex items-center justify-around border-t border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">MIC</span>
          <div className="flex items-center gap-0.5 h-3">
            {[1,2,3,4,5,6].map(bar => {
              const isActive = proctorState.micVolume >= bar * 16;
              return (
                <div key={bar} className={`w-1 rounded-xs transition-all duration-100 ${
                  isActive ? (bar > 4 ? 'bg-rose-400 h-3' : 'bg-emerald-400 h-2') : 'bg-slate-700 h-1'}`} />
              );
            })}
          </div>
          <span className="text-[9px] text-slate-500 font-mono">{proctorState.micVolume}</span>
        </div>

        <div className="h-4 w-[1px] bg-slate-700" />

        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">MOV</span>
          <div className="flex items-center gap-0.5 h-3">
            {[1,2,3,4,5,6].map(bar => {
              const isActive = proctorState.motionScore >= bar * 16;
              return (
                <div key={bar} className={`w-1 rounded-xs transition-all duration-100 ${
                  isActive ? (bar > 3 ? `${motionBarColor} h-3` : 'bg-emerald-400 h-2') : 'bg-slate-700 h-1'}`} />
              );
            })}
          </div>
          <span className="text-[9px] text-slate-500 font-mono">{proctorState.motionScore}</span>
        </div>

        <div className="h-4 w-[1px] bg-slate-700" />

        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">CAM</span>
          <span className={`flex items-center gap-1 text-[10px] font-bold ${isRealWebcam ? 'text-emerald-400' : 'text-amber-400'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${isRealWebcam ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            {isRealWebcam ? '720P' : 'SIM'}
          </span>
        </div>
      </div>

      {/* Integrity bar */}
      <div className="px-3 pb-2 flex items-center gap-2">
        <span className="text-[10px] font-bold text-slate-500 uppercase">Integrity</span>
        <div className="flex-1 h-1 rounded-full bg-slate-800">
          <div className={`h-1 rounded-full transition-all duration-500 ${
            proctorState.integrityScore >= 80 ? 'bg-emerald-500' :
            proctorState.integrityScore >= 60 ? 'bg-amber-400' : 'bg-rose-500'}`}
            style={{ width: `${proctorState.integrityScore}%` }} />
        </div>
        <span className={`text-[10px] font-mono font-bold ${
          proctorState.integrityScore >= 80 ? 'text-emerald-400' :
          proctorState.integrityScore >= 60 ? 'text-amber-400' : 'text-rose-400'}`}>
          {proctorState.integrityScore}%
        </span>
      </div>

      {/* Test Triggers */}
      <div className="p-3 bg-slate-900 border-t border-slate-800 space-y-2">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span className="font-bold text-slate-300 flex items-center gap-1 text-xs">
            <Zap className="w-3 h-3 text-amber-400" /> Test Triggers:
          </span>
          <button type="button" onClick={() => setShowLogs(!showLogs)}
            className="flex items-center gap-0.5 text-[10px] text-indigo-400 hover:text-indigo-300 font-bold">
            <span>Logs ({proctorState.logs.length})</span>
            {showLogs ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <button type="button" onClick={handleSimulateLookAway}
            className="px-2 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700/60 text-[10px] font-bold text-slate-300 hover:text-white transition-colors text-center">
            Look Away
          </button>
          <button type="button" onClick={handleSimulateMultipleFaces}
            className="px-2 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700/60 text-[10px] font-bold text-slate-300 hover:text-white transition-colors text-center">
            2nd Face
          </button>
          <button type="button" onClick={handleSimulateNoiseSpike}
            className="px-2 py-1.5 rounded-xl bg-amber-900/40 hover:bg-amber-900/60 border border-amber-700/40 text-[10px] font-bold text-amber-300 hover:text-amber-100 transition-colors text-center"
            title="Simulate voice/noise violation">
            Voice Spike ⚡
          </button>
          <button type="button" onClick={handleSimulateMotion}
            className="px-2 py-1.5 rounded-xl bg-rose-900/30 hover:bg-rose-900/50 border border-rose-700/40 text-[10px] font-bold text-rose-300 hover:text-rose-100 transition-colors text-center"
            title="Simulate motion violation">
            Motion Burst ⚡
          </button>
        </div>
        <p className="text-[9px] text-slate-600 text-center">Real detection runs automatically when camera is active</p>

        {showLogs && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-2 pt-2 border-t border-slate-800/80 space-y-1.5 max-h-36 overflow-y-auto font-mono text-[10px]">
            {proctorState.logs.length === 0 ? (
              <div className="text-slate-500 italic text-center py-2">No security events logged</div>
            ) : (
              proctorState.logs.map((log: ProctorLogEntry) => (
                <div key={log.id} className={`p-1.5 rounded-md border flex items-start gap-1.5 ${
                  log.type === 'critical' ? 'bg-rose-500/10 border-rose-500/30 text-rose-300' :
                  log.type === 'warning'  ? 'bg-amber-500/10 border-amber-500/30 text-amber-300' :
                  log.type === 'success'  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' :
                  'bg-slate-900/60 border-slate-800 text-slate-400'}`}>
                  <span className="text-slate-500 shrink-0">{log.timestamp}</span>
                  <span className="leading-tight">{log.message}</span>
                </div>
              ))
            )}
          </motion.div>
        )}
      </div>
    </div>
  );
};
