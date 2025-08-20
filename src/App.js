import React, { useCallback, useEffect, useRef, useState } from "react";
import { Upload, Files, X, Loader2 } from "lucide-react";
import { PDFDocument, rgb, degrees, StandardFonts } from 'pdf-lib';

// Helper: read a File/Blob into ArrayBuffer
async function fileToArrayBuffer(file) {
  return await file.arrayBuffer();
}

// Helper: download
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function WatermarkApp() {
  const [textWM, setTextWM] = useState("CONFIDENTIAL");
  const [opacity, setOpacity] = useState(0.25);
  const [files, setFiles] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [logs, setLogs] = useState([]);
  const dropRef = useRef(null);

  const log = (m) => setLogs(prev => [m, ...prev].slice(0, 200));

  const onDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const dropped = Array.from(e.dataTransfer.files || []).filter(f => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
    if (dropped.length) setFiles(prev => [...prev, ...dropped]);
  }, []);

  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;
    const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
    el.addEventListener("dragover", prevent);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", prevent);
      el.removeEventListener("drop", onDrop);
    };
  }, [onDrop]);

  async function addTextWatermark(file) {
    log(`Processing: ${file.name}`);
    const pdfBytes = await fileToArrayBuffer(file);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const pages = pdfDoc.getPages();
    pages.forEach(page => {
      const { width, height } = page.getSize();
      page.drawText(textWM, {
        x: width / 2 - 100,
        y: height / 2,
        size: 36,
        font,
        color: rgb(0.75, 0.75, 0.75),
        rotate: degrees(45),
        opacity
      });
    });

    const newPdfBytes = await pdfDoc.save();
    const blob = new Blob([newPdfBytes], { type: 'application/pdf' });
    downloadBlob(blob, file.name.replace(/\.pdf$/i, '') + '_watermarked.pdf');
    log(`Done: ${file.name}`);
  }

  async function handleProcessAll() {
    if (!files.length) return;
    setProcessing(true);
    try {
      for (const f of files) {
        await addTextWatermark(f);
      }
    } catch (e) {
      log(`Error: ${e.message || e.toString()}`);
      alert('Error during watermarking. Check logs.');
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 backdrop-blur bg-white/70 border-b border-slate-200 p-4 flex justify-between items-center">
        <h1 className="text-xl font-semibold">BackdoorDox Alpha</h1>
        <button disabled={processing || !files.length} onClick={handleProcessAll} className="px-4 py-2 rounded-xl bg-slate-900 text-white disabled:opacity-40">
          {processing ? <Loader2 className="w-4 h-4 animate-spin"/> : `Process ${files.length} PDF(s)`}
        </button>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6">
        <div ref={dropRef} className="bg-white rounded-xl border-2 border-dashed border-slate-300 p-6 text-center min-h-[200px]">
          <h3 className="text-lg font-semibold mb-2">Drag & Drop PDFs here</h3>
          <p className="text-sm text-slate-600 mb-3">or select files manually</p>
          <label className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 text-white cursor-pointer">
            <Files className="w-4 h-4"/> Choose PDFs
            <input type="file" className="hidden" multiple accept="application/pdf" onChange={e => setFiles(prev => [...prev, ...Array.from(e.target.files)])} />
          </label>
        </div>

        {!!files.length && (
          <ul className="mt-4 bg-white rounded-xl shadow divide-y divide-slate-100 max-h-64 overflow-auto">
            {files.map((f, i) => (
              <li key={i} className="px-4 py-2 flex justify-between items-center">
                <span className="truncate">{f.name}</span>
                <button onClick={() => setFiles(files.filter((_, idx) => idx !== i))}><X className="w-4 h-4"/></button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 bg-white rounded-xl shadow p-3 text-xs text-slate-700 font-mono max-h-48 overflow-auto">
          {logs.length ? logs.join('\n') : 'No activity yet.'}
        </div>
      </main>
    </div>
  );
}
