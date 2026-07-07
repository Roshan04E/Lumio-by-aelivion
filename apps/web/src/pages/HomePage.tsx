import { Link, useNavigate } from "react-router-dom";
import { Layers, SlidersHorizontal, Diamond, Sparkles, Download, Zap } from "lucide-react";

const features = [
  { icon: Layers, title: "Real WebGL effects & transitions", copy: "Every effect is a genuine GPU shader — dissolves, glitch, blur, glow — never a CSS overlay fake." },
  { icon: SlidersHorizontal, title: "Color-managed grading", copy: "A Rec.709-linear pipeline with trustworthy scopes: waveform, vectorscope, and RGB parade." },
  { icon: Diamond, title: "Keyframe animation", copy: "Animate transform, color, and effect params on one shared evaluator with auto-keyframing." },
  { icon: Sparkles, title: "AI tools built in", copy: "Auto captions, extract person, remove background, text-behind-person, and smart 3D follow text." },
  { icon: Download, title: "Export in your browser", copy: "WebCodecs encoding runs locally — no upload, no queue. Your footage never leaves your machine." },
  { icon: Zap, title: "Fast on real hardware", copy: "Proxy media, adaptive resolution, and a smart decode budget keep playback smooth on modest laptops." }
];

export function HomePage() {
  const navigate = useNavigate();

  return (
    <div className="mkt-page">
      {/* ---- hero ---- */}
      <section className="mkt-hero">
        <div className="mkt-wrap mkt-hero-inner">
          <span className="mkt-eyebrow">Browser-first · nothing to install</span>
          <h1>
            Pro video editing in the browser. <span className="mkt-grad">AI on your terms.</span>
          </h1>
          <p className="mkt-sub">
            A real timeline with WebGL effects, color grading, and keyframes — plus AI tools you can run
            free with your own chat assistant, or run instantly inside Lumio. Same editable result either way.
          </p>
          <div className="mkt-cta-row">
            <button type="button" className="mkt-btn mkt-btn-primary" onClick={() => navigate("/create")}>
              Start editing free
            </button>
            <a className="mkt-btn mkt-btn-ghost" href="#ai-paths">
              See how the AI works →
            </a>
          </div>
          <p className="mkt-microcopy">No credit card · exports run locally in your browser</p>

          {/* editor wireframe — blueprint of the real NLE, not a screenshot */}
          <div className="mkt-shell">
            <div className="mkt-shell-bar">
              <span className="mkt-tl"><i className="r" /><i className="y" /><i className="g" /></span>
              <span className="proj">your_reel.lumio</span>
              <span className="push" />
              <button type="button" className="exp" onClick={() => navigate("/create")}>Try it →</button>
            </div>
            <div className="mkt-nle" role="img" aria-label="The Lumio editor: media bin, effects, a viewer with live scopes and color wheels, an inspector, and a multi-track timeline with clips, waveforms, keyframes, and a transition.">
              {/* app toolbar */}
              <div className="mkt-nle-toolbar">
                <span className="mkt-nle-menu"><span>File</span><span>Edit</span><span>Clip</span><span>Timeline</span></span>
                <span className="mkt-nle-tools"><i /><i /><i /><i /><i /></span>
                <span className="mkt-nle-spacer" />
                <span className="mkt-nle-tabs"><span className="on">Edit</span><span>Color</span><span>Audio</span><span>Deliver</span></span>
              </div>

              {/* body */}
              <div className="mkt-nle-main">
                {/* left */}
                <div className="mkt-nle-col left">
                  <div className="mkt-nle-panel" style={{ flex: 1 }}>
                    <div className="mkt-nle-phead"><span className="mkt-nle-lbl">Media pool</span><i /></div>
                    <div className="mkt-nle-bin">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <span className="mkt-nle-thumb" key={i} />
                      ))}
                    </div>
                  </div>
                  <div className="mkt-nle-panel">
                    <div className="mkt-nle-phead"><span className="mkt-nle-lbl">Effects</span><i /></div>
                    <div className="mkt-nle-eff">
                      <span className="on">Lumetri</span><span>Blur</span><span>Glow</span><span className="on">Cutout</span><span>Glitch</span><span>Chroma</span><span>Warp</span><span>Grain</span>
                    </div>
                  </div>
                </div>

                {/* center — dual monitors */}
                <div className="mkt-nle-col">
                  <div className="mkt-nle-monitors">
                    <div className="mkt-nle-monitor">
                      <span className="mon-lbl"><span>Source</span><span>00:03:04</span></span>
                      <div className="mkt-nle-frame">
                        <span className="mkt-nle-fig" />
                        <span className="mkt-nle-safe" />
                      </div>
                    </div>
                    <div className="mkt-nle-monitor">
                      <span className="mon-lbl"><span>Program</span><span>00:07:12</span></span>
                      <div className="mkt-nle-frame">
                        <div className="mkt-nle-scopes">
                          <span className="mkt-nle-scope wave" /><span className="mkt-nle-scope parade" /><span className="mkt-nle-scope vector" />
                        </div>
                        <span className="mkt-nle-scan" />
                        <span className="behind">FOCUS</span>
                        <span className="mkt-nle-fig" />
                        <span className="cap">shot on a browser</span>
                        <span className="mkt-nle-safe" />
                      </div>
                    </div>
                  </div>
                  <div className="mkt-nle-transport">
                    <span className="play" />
                    <span className="tc">00:07:12</span>
                    <span className="dots"><i /><i /><i /></span>
                    <span className="grow" />
                    <span>1080×1920 · 30fps</span>
                  </div>
                </div>

                {/* right */}
                <div className="mkt-nle-col right">
                  <div className="mkt-nle-panel">
                    <div className="mkt-nle-phead"><span className="mkt-nle-lbl">Inspector · Transform</span><i /></div>
                    <div className="mkt-nle-row"><span className="k">Scale</span><span className="v kf">124%</span></div>
                    <div className="mkt-nle-slider"><i style={{ left: "60%" }} /></div>
                    <div className="mkt-nle-row"><span className="k">Position</span><span className="v">0, -40</span></div>
                    <div className="mkt-nle-row"><span className="k">Rotation</span><span className="v">-2.5°</span></div>
                    <div className="mkt-nle-slider"><i style={{ left: "46%" }} /></div>
                    <div className="mkt-nle-row"><span className="k">Opacity</span><span className="v">100</span></div>
                  </div>
                  <div className="mkt-nle-panel" style={{ flex: 1 }}>
                    <div className="mkt-nle-phead"><span className="mkt-nle-lbl">Color · Lumetri</span><i /></div>
                    <div className="mkt-nle-wheels"><span className="mkt-nle-wheel" /><span className="mkt-nle-wheel" /><span className="mkt-nle-wheel" /></div>
                    <div className="mkt-nle-row"><span className="k">Temp</span><span className="v">5480K</span></div>
                    <div className="mkt-nle-slider"><i style={{ left: "52%" }} /></div>
                    <div className="mkt-nle-row"><span className="k">Contrast</span><span className="v kf">+12</span></div>
                    <div className="mkt-nle-slider"><i style={{ left: "64%" }} /></div>
                    <div className="mkt-nle-row"><span className="k">Saturation</span><span className="v">108</span></div>
                  </div>
                </div>
              </div>

              {/* timeline */}
              <div className="mkt-nle-timeline">
                <div className="mkt-nle-tlbar">
                  <span className="pill">Snap</span><span className="pill">◱ Zoom</span><span>00:07:12 / 00:24:00</span><span className="mkt-nle-spacer" style={{ flex: 1 }} /><span>V2 · V1 · A1 · A2</span>
                </div>
                <div style={{ position: "relative" }}>
                  <div className="mkt-nle-ruler"><span className="mkt-nle-play" /></div>
                  <div className="mkt-nle-tracks">
                    <div className="mkt-nle-track">
                      <span className="thd">V2</span>
                      <span className="mkt-nle-clip txt" style={{ left: "16%", width: "26%" }}>caption</span>
                      <span className="mkt-nle-kf" style={{ left: "18%" }} /><span className="mkt-nle-kf" style={{ left: "30%" }} /><span className="mkt-nle-kf" style={{ left: "40%" }} />
                      <span className="mkt-nle-clip txt" style={{ left: "62%", width: "18%" }}>title</span>
                    </div>
                    <div className="mkt-nle-track">
                      <span className="thd">V1</span>
                      <span className="mkt-nle-clip v" style={{ left: "6%", width: "40%" }}>a_roll.mp4</span>
                      <span className="mkt-nle-trans" style={{ left: "44%" }} />
                      <span className="mkt-nle-clip v2" style={{ left: "47%", width: "30%" }}>broll_city</span>
                      <span className="mkt-nle-clip v" style={{ left: "79%", width: "16%" }}>end</span>
                    </div>
                    <div className="mkt-nle-track">
                      <span className="thd">A1</span>
                      <span className="mkt-nle-clip a" style={{ left: "6%", width: "72%" }}><span className="wf" /></span>
                    </div>
                    <div className="mkt-nle-track">
                      <span className="thd">A2</span>
                      <span className="mkt-nle-clip a" style={{ left: "40%", width: "55%" }}><span className="wf" /></span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <p className="mkt-wire-cap">A real NLE — timeline, inspector, scopes, color wheels, keyframes &amp; GPU effects.</p>
          </div>
        </div>
      </section>

      {/* ---- two AI paths ---- */}
      <section id="ai-paths" className="mkt-section">
        <div className="mkt-wrap">
          <div className="mkt-sec-head">
            <span className="mkt-eyebrow">The signature idea</span>
            <h2>Every AI tool, two ways to run it.</h2>
            <p>
              Lumio never locks results behind a subscription. Bring your own chat assistant for free, or
              let Lumio run the model for you — both produce the same editable timeline data.
            </p>
          </div>

          <div className="mkt-paths">
            <div className="mkt-path">
              <span className="tag">Path 1 · Free forever</span>
              <h3>Prompt bridge</h3>
              <span className="price">$0 — use ChatGPT, Claude, or any chat AI you already have</span>
              <div className="mkt-flow">
                <div className="mkt-step"><span className="n">01</span> Open a tool — Lumio builds a precise prompt</div>
                <div className="mkt-step"><span className="n">02</span> Paste it into your own chat assistant</div>
                <div className="mkt-step"><span className="n">03</span> Paste the result back into Lumio</div>
                <div className="mkt-step"><span className="n">04</span> Lumio validates it into editable layers</div>
              </div>
            </div>

            <div className="mkt-path-mid"><span className="and">Same result</span></div>

            <div className="mkt-path integrated">
              <span className="tag">Path 2 · Integrated</span>
              <h3>Run it inside Lumio</h3>
              <span className="price">Included with a plan — no copy-paste</span>
              <div className="mkt-flow">
                <div className="mkt-step"><span className="n">01</span> Ask Lumio chat what you want</div>
                <div className="mkt-step"><span className="n">02</span> AI picks the tool and fills the params</div>
                <div className="mkt-step"><span className="n">03</span> Confirm — it runs in-browser or in the cloud</div>
                <div className="mkt-step"><span className="n">04</span> Artifacts drop straight onto your timeline</div>
              </div>
            </div>
          </div>
          <p className="mkt-converge">
            Both paths flow through the same tool registry, so your edit stays <b>fully editable</b> — never a flattened, locked export.
          </p>
        </div>
      </section>

      {/* ---- features ---- */}
      <section className="mkt-section" style={{ paddingTop: 0 }}>
        <div className="mkt-wrap">
          <div className="mkt-sec-head">
            <span className="mkt-eyebrow">Under the hood</span>
            <h2>A real editor, not a template filler.</h2>
            <p>The same deterministic render manifest drives your preview and your export, so what you see is what you ship.</p>
          </div>
          <div className="mkt-grid">
            {features.map((f) => (
              <div className="mkt-card" key={f.title}>
                <span className="ic"><f.icon size={17} /></span>
                <h4>{f.title}</h4>
                <p>{f.copy}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- familiar band ---- */}
      <section className="mkt-section" style={{ paddingTop: 0 }}>
        <div className="mkt-wrap">
          <div className="mkt-band">
            <div>
              <span className="mkt-eyebrow">For Premiere &amp; After Effects users</span>
              <h2>Familiar if you know the tools. Simple if you don&apos;t.</h2>
              <p>
                Multi-track timeline, an inspector, ripple trims, and the keyboard shortcuts your hands
                already know — with a clean on-ramp for creators picking up an editor for the first time.
              </p>
            </div>
            <div className="mkt-shortcuts">
              <span className="lbl">Timeline shortcuts</span>
              <kbd>Space</kbd><span className="k">play</span>
              <kbd>B</kbd><span className="k">blade</span>
              <kbd>C</kbd><span className="k">trim</span>
              <kbd>⌘Z</kbd><span className="k">undo</span>
              <kbd>J</kbd><kbd>K</kbd><kbd>L</kbd><span className="k">shuttle</span>
            </div>
          </div>
        </div>
      </section>

      {/* ---- pricing teaser ---- */}
      <section id="pricing" className="mkt-section" style={{ paddingTop: 0 }}>
        <div className="mkt-wrap">
          <div className="mkt-sec-head">
            <span className="mkt-eyebrow">Pricing</span>
            <h2>Start free. Pay only for convenience.</h2>
            <p>The editor and the prompt-bridge AI path are free forever. Plans add integrated AI and higher limits — your projects always stay editable.</p>
          </div>
          <div className="mkt-tiers">
            <div className="mkt-tier">
              <h3>Free</h3>
              <div className="amt">$0<span> /forever</span></div>
              <ul>
                <li>Full browser editor &amp; timeline</li>
                <li>All WebGL effects &amp; color grading</li>
                <li>Prompt-bridge AI (bring your own chat)</li>
                <li>Local browser export</li>
              </ul>
              <button type="button" className="mkt-btn mkt-btn-ghost" onClick={() => navigate("/create")}>Start free</button>
            </div>
            <div className="mkt-tier feature">
              <span className="badge">Most popular</span>
              <h3>Creator</h3>
              <div className="amt">$12<span> /mo</span></div>
              <ul>
                <li>Everything in Free</li>
                <li>Integrated AI — no copy-paste</li>
                <li>Cloud renders &amp; higher limits</li>
                <li>Priority processing</li>
              </ul>
              <button type="button" className="mkt-btn mkt-btn-primary" onClick={() => navigate("/create")}>Start free trial</button>
            </div>
            <div className="mkt-tier">
              <h3>Pay per output</h3>
              <div className="amt">Usage<span> /job</span></div>
              <ul>
                <li>No subscription</li>
                <li>One-off renders &amp; transcriptions</li>
                <li>Buy credits as you go</li>
                <li>Results stay editable</li>
              </ul>
              <Link to="/tools" className="mkt-btn mkt-btn-ghost">See tools</Link>
            </div>
          </div>
          <p className="mkt-price-note">// credits are metadata — no hard blockers, no locked exports</p>
        </div>
      </section>
    </div>
  );
}
