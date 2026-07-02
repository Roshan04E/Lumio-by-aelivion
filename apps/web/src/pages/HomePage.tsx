import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Clapperboard, Film, Layers3, Scissors, Sparkles, WandSparkles } from "lucide-react";
import { mvpLimits, templateDefinitions, type TemplateDefinition } from "@lumio-by-aelivion/shared";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { TemplateCard } from "../components/TemplateCard";
import { UploadDropzone } from "../components/UploadDropzone";
import { createAsset, createProject, listTemplates } from "../lib/api";

const features = [
  { icon: Layers3, title: "Text behind person", copy: "Masked typography with depth and cutout layers." },
  { icon: WandSparkles, title: "Smart 3D follow text", copy: "Motion text driven by mock tracking points." },
  { icon: Scissors, title: "Remove background", copy: "Transparent and green-screen export structure." },
  { icon: Clapperboard, title: "Viral captions", copy: "Hinglish captions, punch words, and zoom cuts." },
  { icon: Film, title: "Product promo reels", copy: "Price hooks, offer labels, and creator pacing." }
];

export function HomePage() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<TemplateDefinition[]>(templateDefinitions);
  const [prompt, setPrompt] = useState("Make this like a dark scam awareness reel in Hindi with text behind person.");
  const [file, setFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  const previewTemplates = useMemo(() => templates.slice(0, 4), [templates]);

  useEffect(() => {
    listTemplates().then(setTemplates).catch(() => setTemplates(templateDefinitions));
  }, []);

  async function startCreating(templateId?: string) {
    setCreating(true);
    const asset = await createAsset({ file: file ?? undefined, fileName: file?.name ?? "demo-clip.mp4" });
    const project = await createProject({
      title: templateId ? "Template reel" : "Prompt reel",
      templateId,
      sourceAssetId: asset.id,
      prompt: templateId ? undefined : prompt
    });
    navigate(`/editor/${project.id}`);
  }

  return (
    <div className="page">
      <section className="hero-grid">
        <div className="hero-copy">
          <Badge tone="lime">Preview free. Export when satisfied.</Badge>
          <h1>Turn raw videos into trending reels.</h1>
          <p>
            Use cinematic templates, smart follow text, background removal, captions, and motion effects.
          </p>
          <div className="hero-actions">
            <Button icon={<ArrowRight size={17} />} onClick={() => navigate("/create")}>
              Start Creating
            </Button>
            <Button variant="secondary" onClick={() => navigate("/templates")}>
              Explore Templates
            </Button>
          </div>
        </div>

        <Card className="quick-forge">
          <img src="/assets/lumio-by-aelivion-hero.png" alt="" />
          <div className="quick-forge-panel">
            <UploadDropzone file={file} onFile={setFile} />
            <label className="prompt-box">
              <span>Prompt</span>
              <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} />
            </label>
            <Button icon={<Sparkles size={16} />} disabled={creating} onClick={() => startCreating()}>
              {creating ? "Creating..." : "Forge Prompt"}
            </Button>
          </div>
        </Card>
      </section>

      <section className="feature-strip">
        {features.map((feature) => (
          <Card className="feature-card" key={feature.title}>
            <feature.icon size={19} />
            <h3>{feature.title}</h3>
            <p>{feature.copy}</p>
          </Card>
        ))}
      </section>

      <section className="workflow-section">
        <div>
          <Badge tone="muted">Workflow</Badge>
          <h2>Upload, choose a trend, edit, preview, export.</h2>
        </div>
        <div className="workflow-rail">
          {["Upload", "Choose trend", "Edit", "Preview", "Export"].map((step, index) => (
            <div key={step}>
              <span>{index + 1}</span>
              <strong>{step}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="section-heading">
        <div>
          <Badge tone="lime">Templates</Badge>
          <h2>Reusable module stacks</h2>
        </div>
        <Button variant="secondary" onClick={() => navigate("/templates")}>
          View All
        </Button>
      </section>
      <div className="template-grid">
        {previewTemplates.map((template) => (
          <TemplateCard key={template.id} template={template} onUse={() => startCreating(template.id)} />
        ))}
      </div>

      <section className="limits-band">
        {mvpLimits.map((limit) => (
          <Badge key={limit} tone="muted">
            {limit}
          </Badge>
        ))}
      </section>
    </div>
  );
}
