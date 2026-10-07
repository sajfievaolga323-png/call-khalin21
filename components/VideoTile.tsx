"use client";

import { useEffect, useRef, useState } from "react";
import { MicOff } from "lucide-react";
import { drawAquarium, drawForeground } from "./drawAquarium";
import { maskToAlpha, pickPersonMask } from "./segmentation";

const MP_SRC = "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js";

/** Скрипт MediaPipe — классический (не ES-модуль): надёжнее всего подключать его тегом <script>,
 *  тогда конструктор гарантированно появляется в window.SelfieSegmentation (в prod-сборке Next импорт ненадёжен). */
function loadSelfieSegmentation(): Promise<any> {
  const w = window as any;
  if (w.SelfieSegmentation) return Promise.resolve(w.SelfieSegmentation);
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = MP_SRC;
    el.crossOrigin = "anonymous";
    el.onload = () => (w.SelfieSegmentation ? resolve(w.SelfieSegmentation) : reject(new Error("no SelfieSegmentation")));
    el.onerror = () => reject(new Error("failed to load MediaPipe"));
    document.head.appendChild(el);
  }).catch(async () => {
    const mod: any = await import("@mediapipe/selfie_segmentation");
    return mod.SelfieSegmentation;
  });
}

const TASKS_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const TASKS_MODEL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

/** Запасной движок: MediaPipe Tasks на процессоре (работает там, где WebGL-версия отдаёт пустую маску). */
async function createTasksSegmenter(): Promise<any> {
  const url = `${TASKS_BASE}/vision_bundle.mjs`;
  const mod: any = await import(/* webpackIgnore: true */ url);
  const fileset = await mod.FilesetResolver.forVisionTasks(`${TASKS_BASE}/wasm`);
  return mod.ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: TASKS_MODEL, delegate: "CPU" },
    runningMode: "VIDEO",
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
}

type Props = {
  name: string;
  stream: MediaStream | null;
  muted?: boolean;
  micOn?: boolean;
  camOn?: boolean;
  /** Вызывается, когда аквариум включён (трек с обработанным видео) или выключен (null). */
  onProcessedTrack?: (t: MediaStreamTrack | null) => void;
};

const HINTS: Record<string, string> = {
  circle: "Силуэт не распознан, поэтому показываю вас в круге. Проверьте освещение и сядьте чуть дальше от камеры.",
  dark: "Камера отдаёт тёмный кадр. Закройте другие программы и вкладки с камерой, откройте шторку и обновите страницу.",
};

export default function VideoTile({ name, stream, muted = false, micOn = true, camOn = true, onProcessedTrack }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cbRef = useRef(onProcessedTrack);
  cbRef.current = onProcessedTrack;
  const [aquarium, setAquarium] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [hint, setHint] = useState("");
  const [diag, setDiag] = useState("");
  const [showDiag, setShowDiag] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) v.play().catch(() => setBlocked(true)); // автозапуск со звуком может быть запрещён браузером
  }, [stream]);

  // Виртуальный фон: MediaPipe Selfie Segmentation + canvas-аквариум
  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!aquarium || !video || !canvas || !stream) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let stopped = false;
    let raf = 0;
    let mp: any = null;
    let tasks: any = null;
    let outTrack: MediaStreamTrack | null = null;
    // boot: пока грузится модель, показываем круг; mp: основной движок; tasks: запасной; oval: только круг
    let engine: "boot" | "mp" | "tasks" | "oval" = "boot";
    let triedTasks = false;
    let emptyFrames = 0;
    let frames = 0;
    let coverage = 0;
    let brightness = -1;
    let lastDiag = 0;
    let lastHint = "";

    const person = document.createElement("canvas"); // слой «человек» отдельно от фона
    const pctx = person.getContext("2d")!;
    const maskCanvas = document.createElement("canvas");
    const mctx = maskCanvas.getContext("2d", { willReadFrequently: true })!;
    const probe = document.createElement("canvas"); // крошечная копия кадра для замера яркости
    probe.width = 32;
    probe.height = 18;
    const probeCtx = probe.getContext("2d", { willReadFrequently: true })!;
    setLoading(true);
    setFailed(false);
    setHint("");

    const measure = (src: CanvasImageSource) => {
      try {
        probeCtx.drawImage(src, 0, 0, 32, 18);
        const d = probeCtx.getImageData(0, 0, 32, 18).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
        brightness = Math.round(sum / (d.length / 4));
      } catch {}
    };

    const report = () => {
      const now = performance.now();
      if (now - lastDiag < 500) return;
      lastDiag = now;
      const label = engine === "mp" ? "MediaPipe Selfie Segmentation" : engine === "tasks" ? "MediaPipe Tasks (CPU)" : engine === "boot" ? "загрузка модели" : "режим круга";
      setDiag(`${label} · видео ${video.videoWidth}×${video.videoHeight} · кадров ${frames} · силуэт ${(coverage * 100).toFixed(1)}% · яркость ${brightness}`);
      const h = emptyFrames >= 90 ? (brightness >= 0 && brightness <= 15 ? "dark" : "circle") : "";
      if (h !== lastHint) {
        lastHint = h;
        setHint(h);
      }
    };

    /** Рисует кадр: аквариум → человек (по маске, либо мягкий круг, если маски нет) → пузырьки поверх. */
    const paint = (src: CanvasImageSource, md: ImageData | null) => {
      const w = video.videoWidth || 640;
      const h = video.videoHeight || 360;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = person.width = w;
        canvas.height = person.height = h;
      }
      pctx.save();
      pctx.clearRect(0, 0, w, h);
      if (md) {
        if (maskCanvas.width !== md.width || maskCanvas.height !== md.height) {
          maskCanvas.width = md.width;
          maskCanvas.height = md.height;
        }
        mctx.putImageData(md, 0, 0);
        pctx.imageSmoothingEnabled = true;
        pctx.drawImage(maskCanvas, 0, 0, w, h);
        pctx.globalCompositeOperation = "source-in";
        pctx.drawImage(src, 0, 0, w, h);
      } else {
        pctx.drawImage(src, 0, 0, w, h);
        pctx.globalCompositeOperation = "destination-in";
        const g = pctx.createRadialGradient(w / 2, h * 0.55, h * 0.2, w / 2, h * 0.55, h * 0.5);
        g.addColorStop(0, "rgba(0,0,0,1)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        pctx.fillStyle = g;
        pctx.fillRect(0, 0, w, h);
      }
      pctx.restore();
      const t = performance.now() / 1000;
      drawAquarium(ctx, w, h, t);
      ctx.drawImage(person, 0, 0, w, h);
      drawForeground(ctx, w, h, t);
      if (!outTrack) {
        outTrack = (canvas as any).captureStream?.(30)?.getVideoTracks()[0] ?? null;
        cbRef.current?.(outTrack);
      }
      if (frames === 0) setLoading(false);
      if (frames++ % 10 === 0) measure(src);
      report();
    };

    const startTasks = () => {
      if (triedTasks) return;
      triedTasks = true;
      engine = "oval"; // пока грузится запасной движок, показываем круг
      createTasksSegmenter()
        .then((s) => {
          if (stopped) return s.close?.();
          tasks = s;
          emptyFrames = 0;
          engine = "tasks";
        })
        .catch(() => {
          engine = "oval";
          setFailed(true);
        });
    };

    const handleMask = (src: CanvasImageSource, md: ImageData) => {
      coverage = maskToAlpha(md);
      emptyFrames = coverage < 0.005 ? emptyFrames + 1 : 0;
      if (emptyFrames >= 90) {
        paint(src, null);
        if (engine === "mp" && brightness > 15) startTasks(); // основной движок отдаёт пустую маску при нормальном кадре
        else if (engine === "tasks") engine = "oval";
      } else {
        paint(src, md);
      }
    };

    const start = async () => {
      const Ctor = await loadSelfieSegmentation();
      if (stopped || !Ctor) return;
      const MW = 256;
      const MH = 144;
      mp = new Ctor({ locateFile: (f: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${f}` });
      mp.setOptions({ modelSelection: 1 });
      mp.onResults((r: any) => {
        if (stopped || engine !== "mp") return;
        if (maskCanvas.width !== MW || maskCanvas.height !== MH) {
          maskCanvas.width = MW;
          maskCanvas.height = MH;
        }
        mctx.clearRect(0, 0, MW, MH);
        mctx.drawImage(r.segmentationMask, 0, 0, MW, MH);
        handleMask(r.image, mctx.getImageData(0, 0, MW, MH));
      });
      engine = "mp";
    };

    const onTasks = (res: any) => {
      const masks = (res.confidenceMasks ?? []).map((m: any) => ({ data: m.getAsFloat32Array(), width: m.width, height: m.height }));
      const p = pickPersonMask(masks);
      handleMask(video, p ? new ImageData(new Uint8ClampedArray(p.data), p.width, p.height) : new ImageData(16, 16));
    };

    const loop = async () => {
      if (stopped) return;
      try {
        if (video.readyState >= 2) {
          if (engine === "mp") await mp.send({ image: video });
          else if (engine === "tasks") tasks.segmentForVideo(video, performance.now(), onTasks);
          else paint(video, null);
        }
      } catch {}
      raf = requestAnimationFrame(loop);
    };

    start().catch(() => startTasks()); // не загрузился основной движок: пробуем запасной
    loop();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      try { mp?.close?.(); } catch {}
      try { tasks?.close?.(); } catch {}
      outTrack?.stop();
      cbRef.current?.(null);
      setLoading(false);
      setHint("");
      setDiag("");
    };
  }, [aquarium, stream]);

  const showCanvas = aquarium && camOn;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="glass relative aspect-video overflow-hidden bg-ocean-panel/60">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={muted}
          className={`absolute inset-0 h-full w-full object-cover ${showCanvas ? "opacity-0" : ""}`}
        />
        <canvas ref={canvasRef} className={`absolute inset-0 h-full w-full object-cover ${showCanvas ? "" : "hidden"}`} />
        {!camOn && (
          <div className="absolute inset-0 flex items-center justify-center bg-ocean-panel">
            <span className="flex h-20 w-20 items-center justify-center rounded-full bg-ocean-aqua/20 text-3xl font-bold text-ocean-aqua">
              {name.slice(0, 1).toUpperCase()}
            </span>
          </div>
        )}
        {showCanvas && hint && !loading && (
          <div className="absolute inset-x-2 top-2 rounded-lg bg-black/60 px-3 py-2 text-center text-sm text-ocean-aqua">{HINTS[hint]}</div>
        )}
        {loading && <div className="absolute inset-0 flex items-center justify-center bg-ocean-bg/60 text-sm">Загрузка модели…</div>}
        {blocked && (
          <button
            onClick={() => videoRef.current?.play().then(() => setBlocked(false)).catch(() => {})}
            className="absolute inset-0 flex items-center justify-center bg-ocean-bg/70 text-base font-medium text-ocean-aqua"
          >
            ▶ Нажмите, чтобы включить видео и звук
          </button>
        )}
        <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-lg bg-black/50 px-2 py-1 text-sm">
          {!micOn && <MicOff size={14} className="text-ocean-coral" />}
          {name}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => setAquarium((v) => !v)}
          aria-pressed={aquarium}
          className={`rounded-xl border px-3 py-1.5 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ocean-aqua ${
            aquarium ? "border-ocean-aqua bg-ocean-aqua/20 text-ocean-aqua" : "border-white/20 bg-white/10 text-white/80 hover:bg-white/20"
          }`}
        >
          🐠 Аквариум {aquarium ? "вкл" : "выкл"}
        </button>
        {aquarium && (
          <button onClick={() => setShowDiag((v) => !v)} className="text-xs text-white/50 underline hover:text-white/80">
            Диагностика
          </button>
        )}
        {failed && <span className="text-xs text-ocean-coral">Не удалось загрузить модель. Проверьте интернет.</span>}
      </div>
      {aquarium && showDiag && <p className="break-words text-xs text-white/60">{diag || "…"}</p>}
    </div>
  );
}
