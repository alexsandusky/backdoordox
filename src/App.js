import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Settings, Upload, Files, X, Loader2, Link as LinkIcon, Eye, ShieldAlert, FileCode2, Fingerprint, Hash } from "lucide-react";
import { PDFDocument, degrees } from "pdf-lib";

/**
 * AQUAMARK RIVAL – ULTRA-LEAN MVP
 * -----------------------------------------------------------
 * What this single-file React app does (client-side only):
 * 1) Upload one or more PDFs
 * 2) Add **OCR-safe** watermarks (logo and/or text) without rasterizing pages
 * 3) Optionally embed a unique fingerprint + custom metadata in the PDF
 * 4) Either:
 *    - Download the watermarked PDF(s), OR
 *    - Generate a **single-file view-only HTML** (no-download viewer) that streams
 *      the PDF with PDF.js and calls your tracking endpoint on open
 *      (so your server can log IP/device headers). You host/share that HTML.
 *
 * NOTES:
 * - This is a prototype: view-only is best-effort. A determined actor can still screen-capture.
 * - For true IP logging you need a server endpoint (sample code included below in comments).
 * - All watermarking happens locally in the browser. Files are never uploaded by this app.
 */

// ---------- Helpers ----------
async function fileToArrayBuffer(file) { return await file.arrayBuffer(); }

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function uint8ToBase64(u8) {
  let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

// Simple, readable hash (not crypto-secure) for per-recipient fingerprint strings
async function simpleHash(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const b = Array.from(new Uint8Array(buf)).map(x=>x.toString(16).padStart(2,"0")).join("");
  return b.slice(0, 16); // short id
}

const POSITION_PRESETS = [
  { key: "diagonal", label: "Diagonal Center" },
  { key: "bottomRight", label: "Bottom Right" },
  { key: "topLeft", label: "Top Left" },
  { key: "center", label: "Center" },
  { key: "tiled", label: "Tiled Grid" },
  { key: "footer", label: "Footer" },
];

export default function App() {
  // Files & inputs
  const [files, setFiles] = useState([]);
  const [logoFile, setLogoFile] = useState(null);
  const [textWM, setTextWM] = useState("");
  const [opacity, setOpacity] = useState(0.22);
  const [scale, setScale] = useState(0.5);
  const [angle, setAngle] = useState(45);
  const [position, setPosition] = useState("diagonal");
  const [margin, setMargin] = useState(24);
  const [gap, setGap] = useState(180);
  const [embedAs, setEmbedAs] = useState("image"); // image | text | both

  // Fingerprint + metadata
  const [recipient, setRecipient] = useState(""); // email or name
  const [caseId, setCaseId] = useState("");
  const [embedFingerprint, setEmbedFingerprint] = useState(true);
  const [tinyForensicText, setTinyForensicText] = useState(true); // puts a 0.1 opacity tiny line in margin

  // Output
  const [outputMode, setOutputMode] = useState("download"); // download | viewer
  const [viewerTitle, setViewerTitle] = useState("Confidential Document Viewer");
  const [trackingURL, setTrackingURL] = useState(""); // optional; if set, viewer POSTs here on open

  const [processing, setProcessing] = useState(false);
  const [logs, setLogs] = useState([]);
  const dropRef = useRef(null);

  const log = (m) => setLogs(prev => [m, ...prev].slice(0, 400));

  const onDrop = useCallback((e) => {
    e.preventDefault(); e.stopPropagation();
    const dropped = Array.from(e.dataTransfer.files || []).filter(f => /\.pdf$/i.test(f.name));
    if (dropped.length) setFiles(prev => [...prev, ...dropped]);
  }, []);

  useEffect(() => {
    const el = dropRef.current; if (!el) return;
    const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
    el.addEventListener("dragover", prevent);
    el.addEventListener("drop", onDrop);
    return () => { el.removeEventListener("dragover", prevent); el.removeEventListener("drop", onDrop); };
  }, [onDrop]);

  async function processOne(file) {
    log(`Processing: ${file.name}`);
    const pdfBytes = await fileToArrayBuffer(file);
    const pdfDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false });

    // Optional: embed metadata/fingerprint
    let fpStr = "";
    if (embedFingerprint) {
      const ts = new Date().toISOString();
      const ident = `${recipient || "unknown"}|${caseId || "n/a"}|${ts}`;
      const shortId = await simpleHash(ident);
      fpStr = `RID:${shortId}`;
      try {
        pdfDoc.setTitle(file.name.replace(/\.pdf$/i, ""));
        pdfDoc.setSubject("Confidential – Watermarked");
        pdfDoc.setAuthor(recipient || "ISO");
        pdfDoc.setKeywords(["watermarked", fpStr, recipient || "", caseId || ""]);
        pdfDoc.setProducer("AquaMark Rival MVP");
        pdfDoc.setCreationDate(new Date());
        pdfDoc.setModificationDate(new Date());
      } catch {}
    }

    // Embed image logo if provided
    let embeddedImg = null, imgDims = null;
    if (logoFile) {
      const bytes = await fileToArrayBuffer(logoFile);
      const isPng = /\.png$/i.test(logoFile.name);
      embeddedImg = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
      imgDims = embeddedImg.scale(1);
    }

    // Fonts
    const font = await pdfDoc.embedFont("Helvetica-Bold");

    const pages = pdfDoc.getPages();
    for (let page of pages) {
      const { width, height } = page.getSize();
      const minDim = Math.min(width, height);

      // ---- image watermark ----
      const drawImageWM = () => {
        if (!embeddedImg) return;
        let imgW = imgDims.width, imgH = imgDims.height;
        const target = minDim * scale; const ratio = imgW / imgH;
        if (imgW >= imgH) { imgW = target; imgH = target / ratio; } else { imgH = target; imgW = target * ratio; }
        const drawAt = (x, y, rot=null) => page.drawImage(embeddedImg, { x, y, width: imgW, height: imgH, opacity, rotate: rot?degrees(rot):undefined });
        if (position === "diagonal") drawAt((width - imgW)/2, (height - imgH)/2, angle);
        else if (position === "bottomRight") drawAt(width - imgW - margin, margin, 0);
        else if (position === "topLeft") drawAt(margin, height - imgH - margin, 0);
        else if (position === "center") drawAt((width - imgW)/2, (height - imgH)/2, 0);
        else if (position === "footer") drawAt((width - imgW)/2, margin, 0);
        else if (position === "tiled") {
          const xCount = Math.ceil(width / gap) + 1; const yCount = Math.ceil(height / gap) + 1;
          for (let i=0;i<xCount;i++){ for (let j=0;j<yCount;j++){ const x=i*gap - imgW/2; const y=j*gap - imgH/2; page.drawImage(embeddedImg,{x,y,width:imgW,height:imgH,opacity,rotate:degrees(angle)}); }}
        }
      };

      // ---- text watermark ----
      const drawTextWM = () => {
        const content = textWM || (embedFingerprint ? fpStr : "");
        if (!content) return;
        const fontSize = Math.max(10, minDim * scale * 0.25);
        const tw = font.widthOfTextAtSize(content, fontSize);
        const th = fontSize;
        const drawAt = (x,y,rot=null) => page.drawText(content, { x,y,size:fontSize,font,opacity,rotate:rot?degrees(rot):undefined });
        if (position === "diagonal") drawAt((width - tw)/2, (height - th)/2, angle);
        else if (position === "bottomRight") drawAt(width - tw - margin, margin, 0);
        else if (position === "topLeft") drawAt(margin, height - th - margin, 0);
        else if (position === "center") drawAt((width - tw)/2, (height - th)/2, 0);
        else if (position === "footer") drawAt((width - tw)/2, margin, 0);
        else if (position === "tiled") {
          const xCount = Math.ceil(width / gap) + 1; const yCount = Math.ceil(height / gap) + 1;
          for (let i=0;i<xCount;i++){ for (let j=0;j<yCount;j++){ const x=i*gap - tw/2; const y=j*gap - th/2; page.drawText(content,{x,y,size:fontSize,font,opacity,rotate:degrees(angle)}); }}
        }
      };

      if (embedAs === "image" || embedAs === "both") drawImageWM();
      if (embedAs === "text" || embedAs === "both" || (!textWM && embedFingerprint)) drawTextWM();

      // Optional tiny forensic line near margin (ultra low opacity)
      if (tinyForensicText && embedFingerprint && fpStr) {
        try {
          page.drawText(`${fpStr} | ${recipient || ""} | ${caseId || ""}`.trim(), {
            x: margin, y: margin/2,
            size: 6, opacity: 0.1, font
          });
        } catch {}
      }
    }

    const newPdfBytes = await pdfDoc.save({ useObjectStreams: false, addDefaultPage: false });
    const outName = file.name.replace(/\.pdf$/i, "") + "_wm.pdf";

    if (outputMode === "download") {
      downloadBlob(new Blob([newPdfBytes], { type: "application/pdf" }), outName);
      log(`Done: ${outName}`);
      return null;
    }

    // Generate single-file viewer HTML that fetches the PDF (embedded as base64) via PDF.js
    const base64 = uint8ToBase64(new Uint8Array(newPdfBytes));
    const viewerHTML = buildViewerHTML({
      title: viewerTitle || "Confidential Document Viewer",
      base64PDF: base64,
      trackingURL: trackingURL || "",
      recipient, caseId
    });
    const htmlBlob = new Blob([viewerHTML], { type: "text/html;charset=utf-8" });
    const htmlName = outName.replace(/\.pdf$/i, "").replace(/\.pdf$/i, "") + "_viewer.html";
    downloadBlob(htmlBlob, htmlName);
    log(`Viewer generated: ${htmlName}`);
    return null;
  }

  async function handleProcessAll() {
    if (!files.length) return;
    if (!logoFile && embedAs === "image") { alert("Upload a logo or switch to Text/Both."); return; }
    setProcessing(true);
    try {
      for (const f of files) { // sequential to keep memory low
        // eslint-disable-next-line no-await-in-loop
        await processOne(f);
      }
    } catch (e) {
      console.error(e); log(`Error: ${e.message || String(e)}`); alert("Processing error. See logs.");
    } finally { setProcessing(false); }
  }

  const onFilesPicked = (e) => { const picked = Array.from(e.target.files || []); if (picked.length) setFiles(prev => [...prev, ...picked]); };
  const onLogoPicked = (e) => { const f = e.target.files?.[0]; if (f) setLogoFile(f); };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 backdrop-blur bg-white/70 border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="w-9 h-9 rounded-2xl bg-slate-900 text-white grid place-items-center">WM</div>
          <div className="flex-1">
            <h1 className="text-xl font-semibold">AquaMark‑Rival – MVP (Client‑Side + Viewer Generator)</h1>
            <p className="text-sm text-slate-600">OCR‑safe overlays · per‑recipient fingerprint · optional no‑download viewer with tracking hook.</p>
          </div>
          <button disabled={processing || !files.length} onClick={handleProcessAll} className="px-4 py-2 rounded-2xl bg-slate-900 text-white disabled:opacity-40 flex items-center gap-2 shadow">
            {processing ? <Loader2 className="w-4 h-4 animate-spin"/> : outputMode === 'download' ? <Download className="w-4 h-4"/> : <Eye className="w-4 h-4"/>}
            {processing ? "Processing…" : outputMode === 'download' ? `Process ${files.length}` : `Build Viewer for ${files.length}`}
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 grid lg:grid-cols-3 gap-6">
        {/* Controls */}
        <section className="lg:col-span-1">
          <div className="bg-white rounded-2xl shadow p-4 space-y-4">
            <div className="flex items-center gap-2"><Settings className="w-4 h-4"/><h2 className="font-semibold">Watermark Settings</h2></div>
            <div>
              <label className="block text-sm font-medium mb-1">Mode</label>
              <div className="flex gap-2 flex-wrap">
                {[['image','Logo'],['text','Text'],['both','Both']].map(([k,l]) => (
                  <button key={k} onClick={()=>setEmbedAs(k)} className={`px-3 py-1.5 rounded-xl border ${embedAs===k?"bg-slate-900 text-white border-slate-900":"border-slate-300"}`}>{l}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Logo (PNG/JPG)</label>
              <div className="flex items-center gap-2">
                <input type="file" accept="image/png,image/jpeg" onChange={onLogoPicked} />
                {logoFile ? <span className="text-xs text-slate-600 truncate max-w-[10rem]">{logoFile.name}</span> : <span className="text-xs text-slate-400">No file chosen</span>}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Text Watermark</label>
              <input type="text" value={textWM} onChange={e=>setTextWM(e.target.value)} placeholder="e.g., CONFIDENTIAL – BrokerCo" className="w-full border border-slate-300 rounded-xl px-3 py-2"/>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Opacity: {Math.round(opacity*100)}%</label>
                <input type="range" min={0.05} max={0.8} step={0.01} value={opacity} onChange={e=>setOpacity(parseFloat(e.target.value))} className="w-full"/>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Scale: {(scale*100).toFixed(0)}%</label>
                <input type="range" min={0.2} max={1.2} step={0.05} value={scale} onChange={e=>setScale(parseFloat(e.target.value))} className="w-full"/>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Angle: {angle}°</label>
                <input type="range" min={-90} max={90} step={5} value={angle} onChange={e=>setAngle(parseInt(e.target.value))} className="w-full"/>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Margin: {margin}px</label>
                <input type="range" min={0} max={96} step={2} value={margin} onChange={e=>setMargin(parseInt(e.target.value))} className="w-full"/>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 items-end">
              <div>
                <label className="block text-sm font-medium mb-1">Position</label>
                <select value={position} onChange={e=>setPosition(e.target.value)} className="w-full border border-slate-300 rounded-xl px-3 py-2">
                  {POSITION_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </div>
              {position === "tiled" && (
                <div>
                  <label className="block text-sm font-medium mb-1">Grid Gap: {gap}px</label>
                  <input type="range" min={80} max={360} step={10} value={gap} onChange={e=>setGap(parseInt(e.target.value))} className="w-full"/>
                </div>
              )}
            </div>

            <div className="rounded-xl bg-sky-50 border border-sky-200 p-3 text-sky-900 text-sm flex gap-2">
              <ShieldAlert className="w-4 h-4 mt-0.5"/>
              <div>
                <p className="font-medium">OCR‑safe by design</p>
                <p>Pages are not rasterized; overlays are vector/text so OCR and underwriting extraction still work.</p>
              </div>
            </div>
          </div>

          {/* Fingerprint */}
          <div className="bg-white rounded-2xl shadow p-4 space-y-3 mt-4">
            <div className="flex items-center gap-2"><Fingerprint className="w-4 h-4"/><h2 className="font-semibold">Per‑Recipient Fingerprint</h2></div>
            <input className="w-full border border-slate-300 rounded-xl px-3 py-2" placeholder="Recipient email or name" value={recipient} onChange={e=>setRecipient(e.target.value)} />
            <input className="w-full border border-slate-300 rounded-xl px-3 py-2" placeholder="Case ID / Deal name (optional)" value={caseId} onChange={e=>setCaseId(e.target.value)} />
            <div className="flex items-center gap-2 text-sm">
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={embedFingerprint} onChange={e=>setEmbedFingerprint(e.target.checked)} /> Embed metadata + short ID</label>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={tinyForensicText} onChange={e=>setTinyForensicText(e.target.checked)} /> Tiny forensic line in margin</label>
            </div>
          </div>

          {/* Output */}
          <div className="bg-white rounded-2xl shadow p-4 space-y-3 mt-4">
            <div className="flex items-center gap-2"><LinkIcon className="w-4 h-4"/><h2 className="font-semibold">Output</h2></div>
            <div className="flex gap-2 flex-wrap">
              {[['download','Download PDF'],['viewer','Generate Viewer HTML']].map(([k,l]) => (
                <button key={k} onClick={()=>setOutputMode(k)} className={`px-3 py-1.5 rounded-xl border ${outputMode===k?"bg-slate-900 text-white border-slate-900":"border-slate-300"}`}>{l}</button>
              ))}
            </div>
            {outputMode === 'viewer' && (
              <div className="space-y-2">
                <input className="w-full border border-slate-300 rounded-xl px-3 py-2" placeholder="Viewer Title" value={viewerTitle} onChange={e=>setViewerTitle(e.target.value)} />
                <input className="w-full border border-slate-300 rounded-xl px-3 py-2" placeholder="Tracking Endpoint URL (optional)" value={trackingURL} onChange={e=>setTrackingURL(e.target.value)} />
                <p className="text-xs text-slate-600">If set, the generated HTML will POST to this URL on open with headers. Your server can log IP/device. Sample Express endpoint included in comments below.</p>
              </div>
            )}
          </div>
        </section>

        {/* Work area */}
        <section className="lg:col-span-2">
          <div ref={dropRef} className="bg-white rounded-2xl border-2 border-dashed border-slate-300 p-6 grid place-items-center text-center min-h-[260px]">
            <div className="max-w-md">
              <div className="mx-auto w-12 h-12 rounded-2xl bg-slate-100 grid place-items-center mb-3"><Upload className="w-6 h-6"/></div>
              <h3 className="text-lg font-semibold mb-1">Drag & Drop PDFs here</h3>
              <p className="text-sm text-slate-600 mb-3">or</p>
              <label className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 text-white cursor-pointer">
                <Files className="w-4 h-4"/> Choose PDFs
                <input type="file" className="hidden" multiple accept="application/pdf" onChange={onFilesPicked} />
              </label>
              <p className="text-xs text-slate-500 mt-3">All processing is 100% client‑side in your browser. Files never leave your device.</p>
            </div>
          </div>

          {!!files.length && (
            <div className="mt-4 bg-white rounded-2xl shadow">
              <div className="p-4 border-b border-slate-200 flex items-center justify-between">
                <h4 className="font-semibold">Queue ({files.length})</h4>
                <button className="text-sm text-slate-600 hover:text-slate-900" onClick={()=>setFiles([])}>Clear</button>
              </div>
              <ul className="divide-y divide-slate-100 max-h-64 overflow-auto">
                {files.map((f, i) => (
                  <li key={i} className="px-4 py-3 text-sm flex items-center justify-between">
                    <span className="truncate mr-2">{f.name}</span>
                    <button onClick={()=>setFiles(files.filter((_,idx)=>idx!==i))} className="text-slate-400 hover:text-slate-900" title="Remove"><X className="w-4 h-4"/></button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 bg-white rounded-2xl shadow">
            <div className="p-4 border-b border-slate-200 flex items-center gap-2"><h4 className="font-semibold">Logs</h4></div>
            <div className="p-3 text-xs text-slate-700 max-h-56 overflow-auto font-mono whitespace-pre-wrap">
              {logs.length ? logs.join("\n") : "No activity yet. Add PDFs and click Process."}
            </div>
          </div>

          <div className="mt-4 text-xs text-slate-500">
            <p>Limitations: Password‑protected PDFs not supported; very large PDFs may be memory‑heavy. For high‑volume server pipelines, port this logic to Node.js using pdf-lib.</p>
          </div>
        </section>
      </main>

      {/* ----
        SINGLE‑FILE VIEWER BUILDER
        We inline a tiny HTML shell that loads PDF.js from a CDN, disables default
        download/print UI, blocks right‑click + common hotkeys, and optionally POSTs
        to your tracking endpoint so your server captures IP + headers.
      ---- */}
    </div>
  );
}

function buildViewerHTML({ title, base64PDF, trackingURL, recipient, caseId }) {
  const safeTitle = (title || "Viewer").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const payloadJS = trackingURL ? `
    try {
      fetch('${trackingURL}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'open',
          ts: new Date().toISOString(),
          recipient: ${JSON.stringify(recipient || '')},
          caseId: ${JSON.stringify(caseId || '')},
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          language: navigator.language,
          userAgent: navigator.userAgent,
          screen: { w: window.screen.width, h: window.screen.height, dpr: window.devicePixelRatio }
        })
      }).catch(()=>{});
    } catch(e) {}
  ` : "";

  // Minimal PDF.js embed (no toolbar). We rely on CDN; host this HTML anywhere.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>${safeTitle}</title>
    <style>
      html,body,#app{height:100%;margin:0;background:#0b1220;color:#e5e7eb;font-family:Inter,system-ui,Segoe UI,Roboto,Arial,sans-serif}
      header{position:sticky;top:0;background:rgba(11,18,32,.8);backdrop-filter:saturate(1.2) blur(8px);border-bottom:1px solid #1f2937;padding:10px 14px;display:flex;align-items:center;gap:10px}
      .badge{font-size:12px;opacity:.7}
      canvas{display:block;margin:0 auto;max-width:100%}
      .page{margin:16px auto;box-shadow:0 8px 24px rgba(0,0,0,.4);border-radius:8px;overflow:hidden}
      .hint{position:fixed;bottom:10px;left:50%;transform:translateX(-50%);font-size:12px;opacity:.6}
      /* Best‑effort disable text selection and context menu */
      *{user-select:none;-webkit-user-select:none}
    </style>
    <script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.js"></script>
  </head>
  <body>
    <header>
      <div style="width:28px;height:28px;border-radius:10px;background:#111827;color:white;display:grid;place-items:center;font-weight:700">WM</div>
      <div style="flex:1">
        <div style="font-weight:600">${safeTitle}</div>
        <div class="badge">View‑only · Download/Print disabled</div>
      </div>
    </header>
    <div id="app"></div>
    <div class="hint">Screenshots can still happen. Your IP and headers may be logged.</div>
    <script>
      ${payloadJS}
      // PDF.js config
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.js';

      // Block right‑click and common save/print keys
      window.addEventListener('contextmenu', e=>e.preventDefault());
      window.addEventListener('keydown', (e)=>{
        const k = e.key.toLowerCase();
        if ((e.ctrlKey||e.metaKey) && (k==='s'||k==='p'||k==='o')) e.preventDefault();
        if (k==='printscreen') e.preventDefault();
      });

      const base64 = '${base64PDF}';
      const raw = atob(base64);
      const len = raw.length; const bytes = new Uint8Array(len);
      for (let i=0;i<len;i++) bytes[i] = raw.charCodeAt(i);

      (async () => {
        const doc = await pdfjsLib.getDocument({data: bytes}).promise;
        const app = document.getElementById('app');
        for (let p=1; p<=doc.numPages; p++) {
          const page = await doc.getPage(p);
          const viewport = page.getViewport({ scale: 1.2 });
          const canvas = document.createElement('canvas');
          canvas.className = 'page';
          canvas.width = viewport.width; canvas.height = viewport.height;
          const ctx = canvas.getContext('2d', { alpha: false });
          await page.render({ canvasContext: ctx, viewport }).promise;
          app.appendChild(canvas);
        }
      })();
    </script>
  </body>
</html>`;
}

/*
============================================================
OPTIONAL: SUPER‑SIMPLE TRACKING ENDPOINT (Node/Express)
------------------------------------------------------------
This lets you log IP + headers whenever a viewer HTML posts to it.
Deploy on Render, Fly, Railway, Vercel functions, or any Node host.

// server/index.js
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.post('/track', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const ua = req.headers['user-agent'];
  const now = new Date().toISOString();
  const payload = req.body || {};
  console.log(`[${now}]`, { ip, ua, ...payload });
  // TODO: persist to a DB (Supabase/Postgres). For MVP, console logs are fine.
  res.json({ ok: true });
});

app.listen(process.env.PORT || 3000, () => console.log('tracker up')); 

USAGE:
1) Deploy this server and get a public URL, e.g., https://your-app.onrender.com
2) In the React app above, set Tracking Endpoint URL to https://your-app.onrender.com/track
3) Generate the Viewer HTML and share/upload it. Each open triggers a POST with headers.

SECURITY NOTES:
- View-only is deterrence, not a silver bullet. Combine with per-recipient fingerprinting + logs.
- For stronger control, host viewer behind authenticated routes and short-lived signed URLs.
============================================================
*/
