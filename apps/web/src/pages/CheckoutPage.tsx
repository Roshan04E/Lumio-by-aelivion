import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { estimateCreditsForEffects, walletPacks } from "@orreris/shared";
import { buyCredits, fetchUsage, getMe, getProject, type ProjectRecord, type UsageSummary, type UserRecord } from "../lib/api";
import { inr } from "../lib/format";

export function CheckoutPage() {
  const { projectId } = useParams();
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [user, setUser] = useState<UserRecord | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [message, setMessage] = useState("Mock payment ready");

  useEffect(() => {
    if (projectId) {
      getProject(projectId).then(setProject);
    }
    getMe().then(setUser);
    fetchUsage().then(setUsage);
  }, [projectId]);

  const requiredCredits = useMemo(
    () => (project ? estimateCreditsForEffects(project.projectGraph.effects, project.durationSeconds) : 0),
    [project]
  );

  const wallet = user?.walletCredits ?? 0;
  const ready = wallet >= requiredCredits;

  async function purchase(packId: "starter" | "creator" | "growth") {
    await buyCredits(packId, project?.id);
    setUser(await getMe());
    setMessage("Credits added to your wallet.");
  }

  return (
    <div className="mkt-page">
      <section className="mkt-hero" style={{ padding: "56px 0 8px" }}>
        <div className="mkt-wrap mkt-hero-inner">
          <span className="mkt-eyebrow">Checkout</span>
          <h1 style={{ fontSize: "clamp(28px, 3.6vw, 42px)" }}>
            Export credits, <span className="mkt-grad">pay only for output.</span>
          </h1>
          <p className="mkt-sub">Editing and preview are always free. Credits are spent only when you render a final export.</p>
        </div>
      </section>

      <div className="mkt-wrap">
        <div className="mkt-co">
          <aside className="mkt-panel-card mkt-co-summary">
            <h2>{project?.title ?? "Your project"}</h2>
            <p className="proj-sub">order summary</p>
            <div className="mkt-co-row"><span>Wallet balance</span><span className="amt">{wallet} cr</span></div>
            <div className="mkt-co-row"><span>Final export</span><span className="amt accent">{requiredCredits} cr</span></div>
            <div className={`mkt-co-status ${ready ? "ready" : "need"}`}>{ready ? "Ready to export" : "Needs more credits"}</div>
            <p className="mkt-co-msg">// {message}</p>
            {project ? (
              <Link to={`/editor/${project.id}`} className="mkt-co-back"><ArrowLeft size={14} /> Back to editor</Link>
            ) : null}

            {usage && usage.byAction.length > 0 ? (
              <div className="mkt-co-usage">
                <h3>Usage this month <span className="mkt-co-usage-free">free during beta</span></h3>
                <ul>
                  {usage.byAction.map((entry) => (
                    <li key={entry.action}>
                      <span>{entry.action}</span>
                      <span>{entry.credits} cr</span>
                    </li>
                  ))}
                </ul>
                <p className="mkt-co-usage-total">{usage.totalShadowCredits} credits measured — nothing charged.</p>
              </div>
            ) : null}
          </aside>

          <div className="mkt-co-packs">
            {walletPacks.map((pack, index) => (
              <div className={`mkt-co-pack ${index === 1 ? "feature" : ""}`} key={pack.id}>
                <h3>{pack.name}</h3>
                <div className="price">{inr(pack.priceInr)}</div>
                <span className="cr">{pack.credits} credits</span>
                <p>{pack.description}</p>
                <button
                  type="button"
                  className={`mkt-btn ${index === 1 ? "mkt-btn-primary" : "mkt-btn-ghost"}`}
                  onClick={() => purchase(pack.id)}
                >
                  Buy {pack.name}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}