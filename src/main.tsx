import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  BarChart3,
  Check,
  ChevronRight,
  Clapperboard,
  Database,
  FileText,
  Mic2,
  Play,
  Radio,
  RefreshCw,
  Scissors,
  Upload,
  Wand2,
} from "lucide-react";
import "./styles.css";

type PipelineStep = {
  id: string;
  label: string;
  detail: string;
  status: "ready" | "queued" | "running";
  icon: typeof Database;
};

const movers = [
  { ticker: "NVDA", name: "Nvidia", change: "+4.8%", reason: "IA y chips", trend: "up" },
  { ticker: "PLTR", name: "Palantir", change: "+3.9%", reason: "guidance", trend: "up" },
  { ticker: "TSLA", name: "Tesla", change: "-3.2%", reason: "margenes", trend: "down" },
  { ticker: "NFLX", name: "Netflix", change: "-2.7%", reason: "rotacion", trend: "down" },
];

const steps: PipelineStep[] = [
  { id: "research", label: "Cala data", detail: "movers + catalizadores", status: "ready", icon: Database },
  { id: "script", label: "Guion GPT", detail: "hook + narrativa", status: "ready", icon: FileText },
  { id: "voice", label: "ElevenLabs", detail: "voiceover.mp3", status: "queued", icon: Mic2 },
  { id: "edit", label: "Edit plan", detail: "edit.json", status: "queued", icon: Scissors },
  { id: "render", label: "HyperFrames", detail: "composition.html", status: "queued", icon: Clapperboard },
  { id: "export", label: "FFmpeg", detail: "output.mp4", status: "queued", icon: Play },
];

function App() {
  const [format, setFormat] = useState("16:9");
  const [style, setStyle] = useState("finance-news");
  const [voice, setVoice] = useState("Sarah");
  const [topic, setTopic] = useState("Top movers diario: acciones que mas subieron y bajaron hoy");
  const [references, setReferences] = useState("Bloomberg-style financial news, Instagram reels de bolsa, charts grandes, catalizador corto por ticker.");

  const projectId = useMemo(() => `demo-${new Date().toISOString().slice(0, 10)}`, []);

  return (
    <main className="app-shell">
      <section className="command-bar">
        <div>
          <p className="eyebrow">local demo pipeline</p>
          <h1>Finance Video Console</h1>
        </div>
        <button className="primary-action">
          <Wand2 size={18} />
          Generate demo
        </button>
      </section>

      <section className="workspace-grid">
        <aside className="input-panel" aria-label="New video">
          <div className="panel-title">
            <Radio size={18} />
            <h2>Nuevo video</h2>
          </div>

          <label>
            Tematica
            <textarea value={topic} onChange={(event) => setTopic(event.target.value)} rows={4} />
          </label>

          <label>
            Referencias
            <textarea value={references} onChange={(event) => setReferences(event.target.value)} rows={5} />
          </label>

          <div className="field-row">
            <label>
              Skill estilo
              <select value={style} onChange={(event) => setStyle(event.target.value)}>
                <option value="finance-news">Finance news</option>
                <option value="premium-analyst">Premium analyst</option>
                <option value="shorts-fast">Shorts fast</option>
              </select>
            </label>
            <label>
              Voz
              <select value={voice} onChange={(event) => setVoice(event.target.value)}>
                <option>Sarah</option>
                <option>Roger</option>
                <option>Bill</option>
              </select>
            </label>
          </div>

          <div className="segmented" aria-label="Format">
            {["16:9", "9:16"].map((item) => (
              <button key={item} className={format === item ? "active" : ""} onClick={() => setFormat(item)}>
                {item}
              </button>
            ))}
          </div>

          <button className="secondary-action">
            <Upload size={17} />
            Add references
          </button>
        </aside>

        <section className="stage-panel" aria-label="Pipeline">
          <div className="panel-title">
            <Activity size={18} />
            <h2>{projectId}</h2>
          </div>

          <div className="pipeline-strip">
            {steps.map((step) => {
              const Icon = step.icon;
              return (
                <article key={step.id} className={`step ${step.status}`}>
                  <Icon size={18} />
                  <div>
                    <strong>{step.label}</strong>
                    <span>{step.detail}</span>
                  </div>
                  {step.status === "ready" ? <Check size={16} /> : <RefreshCw size={16} />}
                </article>
              );
            })}
          </div>

          <div className="preview-band">
            <div className="video-preview">
              <div className="market-ticker">NVDA +4.8% · PLTR +3.9% · TSLA -3.2% · NFLX -2.7%</div>
              <div className="preview-copy">
                <span>Top movers</span>
                <strong>Las acciones que mas se movieron hoy</strong>
                <p>Cala data → GPT script → ElevenLabs voice → HyperFrames render</p>
              </div>
              <div className="chart-lines" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
            </div>
          </div>
        </section>
      </section>

      <section className="lower-grid">
        <section className="timeline-panel">
          <div className="panel-title">
            <BarChart3 size={18} />
            <h2>Timeline</h2>
          </div>
          <div className="scene-list">
            {movers.map((item, index) => (
              <article className="scene" key={item.ticker}>
                <span className="scene-time">0:{String(index * 6 + 6).padStart(2, "0")}</span>
                <strong>{item.ticker}</strong>
                <em className={item.trend}>{item.change}</em>
                <span>{item.reason}</span>
                <ChevronRight size={16} />
              </article>
            ))}
          </div>
        </section>

        <section className="artifact-panel">
          <div className="panel-title">
            <FileText size={18} />
            <h2>Artefactos</h2>
          </div>
          <div className="artifact-grid">
            {["brief.json", "research.json", "script.md", "voiceover.mp3", "edit.json", "composition.html", "output.mp4"].map((file) => (
              <button key={file}>{file}</button>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
