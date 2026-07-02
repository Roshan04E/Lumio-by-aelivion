import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { estimateCreditsForEffects, walletPacks } from "@lumio-by-aelivion/shared";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { CreditBadge } from "../components/CreditBadge";
import { buyCredits, getMe, getProject, type ProjectRecord, type UserRecord } from "../lib/api";
import { inr } from "../lib/format";

export function CheckoutPage() {
  const { projectId } = useParams();
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [user, setUser] = useState<UserRecord | null>(null);
  const [message, setMessage] = useState("Mock payment ready");

  useEffect(() => {
    if (projectId) {
      getProject(projectId).then(setProject);
    }
    getMe().then(setUser);
  }, [projectId]);

  const requiredCredits = useMemo(
    () => (project ? estimateCreditsForEffects(project.projectGraph.effects, project.durationSeconds) : 0),
    [project]
  );

  async function purchase(packId: "starter" | "creator" | "growth") {
    await buyCredits(packId, project?.id);
    const nextUser = await getMe();
    setUser(nextUser);
    setMessage("Credits added");
  }

  return (
    <div className="page">
      <section className="page-heading">
        <Badge tone="lime">Checkout</Badge>
        <h1>Export credits</h1>
        <p>Preview stays free with watermark. Final export deducts credits.</p>
      </section>

      <div className="checkout-grid">
        <Card className="checkout-summary">
          <h2>{project?.title ?? "Project"}</h2>
          <div className="summary-row">
            <span>Wallet</span>
            <CreditBadge value={user?.walletCredits ?? 0} />
          </div>
          <div className="summary-row">
            <span>Final export</span>
            <CreditBadge value={requiredCredits} />
          </div>
          <Badge tone={(user?.walletCredits ?? 0) >= requiredCredits ? "success" : "danger"}>
            {(user?.walletCredits ?? 0) >= requiredCredits ? "Ready to export" : "Needs credits"}
          </Badge>
          <p>{message}</p>
          {project ? <Link to={`/editor/${project.id}`}>Back to editor</Link> : null}
        </Card>

        <div className="pack-grid">
          {walletPacks.map((pack) => (
            <Card className="pack-card" key={pack.id}>
              <h2>{pack.name}</h2>
              <strong>{inr(pack.priceInr)}</strong>
              <CreditBadge value={pack.credits} />
              <p>{pack.description}</p>
              <Button onClick={() => purchase(pack.id)}>Buy Pack</Button>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
