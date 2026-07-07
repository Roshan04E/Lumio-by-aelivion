import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { GlobalErrorToast } from "./components/GlobalErrorToast";
import { isApiOffline, subscribeApiOffline } from "./lib/api";

const HomePage = lazy(() => import("./pages/HomePage").then((module) => ({ default: module.HomePage })));
const TemplatesPage = lazy(() => import("./pages/TemplatesPage").then((module) => ({ default: module.TemplatesPage })));
const ToolsPage = lazy(() => import("./pages/ToolsPage").then((module) => ({ default: module.ToolsPage })));
const ToolDetailPage = lazy(() => import("./pages/ToolDetailPage").then((module) => ({ default: module.ToolDetailPage })));
const CookbookPage = lazy(() => import("./pages/CookbookPage").then((module) => ({ default: module.CookbookPage })));
const CreatePage = lazy(() => import("./pages/CreatePage").then((module) => ({ default: module.CreatePage })));
const EditorPage = lazy(() => import("./pages/EditorPage").then((module) => ({ default: module.EditorPage })));
const CheckoutPage = lazy(() => import("./pages/CheckoutPage").then((module) => ({ default: module.CheckoutPage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const AdminTemplatesPage = lazy(() => import("./pages/AdminTemplatesPage").then((module) => ({ default: module.AdminTemplatesPage })));
const AdminJobsPage = lazy(() => import("./pages/AdminJobsPage").then((module) => ({ default: module.AdminJobsPage })));
const PreviewFixturePage = lazy(() => import("./pages/PreviewFixturePage").then((module) => ({ default: module.PreviewFixturePage })));
const ExportStressPage = lazy(() => import("./pages/ExportStressPage").then((module) => ({ default: module.ExportStressPage })));
const ExportLiveStressPage = lazy(() => import("./pages/ExportLiveStressPage").then((module) => ({ default: module.ExportLiveStressPage })));
const GovernorStressPage = lazy(() => import("./pages/GovernorStressPage").then((module) => ({ default: module.GovernorStressPage })));
const LocalExportPage = lazy(() => import("./pages/LocalExportPage").then((module) => ({ default: module.LocalExportPage })));
const ExportWorkerSceneProbePage = lazy(() => import("./pages/ExportWorkerSceneProbePage").then((module) => ({ default: module.ExportWorkerSceneProbePage })));
const ExportWorkerScenePage = lazy(() => import("./pages/ExportWorkerScenePage").then((module) => ({ default: module.ExportWorkerScenePage })));
const MediaSharedContextProbePage = lazy(() => import("./pages/MediaSharedContextProbePage").then((module) => ({ default: module.MediaSharedContextProbePage })));
const WcDecoderGatePage = lazy(() => import("./pages/WcDecoderGatePage").then((module) => ({ default: module.WcDecoderGatePage })));
const AuthPage = lazy(() => import("./pages/AuthPage").then((module) => ({ default: module.AuthPage })));

/** Slim status strip while the API is unreachable (api.ts flips the flag; ONE poller reconnects). */
function ApiOfflineBanner() {
  const [offline, setOffline] = useState(() => isApiOffline());
  useEffect(() => subscribeApiOffline(setOffline), []);
  if (!offline) return null;
  return (
    <div className="api-offline-banner" role="status">
      Backend offline — your edits keep saving locally; reconnecting…
    </div>
  );
}

export default function App() {
  return (
    <AppShell>
      <ApiOfflineBanner />
      <GlobalErrorToast />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<AuthPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/tools/:slug" element={<ToolDetailPage />} />
          <Route path="/cookbook" element={<CookbookPage />} />
          <Route path="/cookbook/:sectionId" element={<CookbookPage />} />
          <Route path="/create" element={<CreatePage />} />
          <Route path="/editor/__preview-fixture" element={<PreviewFixturePage />} />
          <Route path="/editor/__export-stress" element={<ExportStressPage />} />
          <Route path="/editor/__export-live-stress" element={<ExportLiveStressPage />} />
          <Route path="/editor/__governor-stress" element={<GovernorStressPage />} />
          <Route path="/editor/__local-export" element={<LocalExportPage />} />
          <Route path="/editor/__export-worker-scene-probe" element={<ExportWorkerSceneProbePage />} />
          <Route path="/editor/__export-worker-scene" element={<ExportWorkerScenePage />} />
          <Route path="/editor/__media-shared-context-probe" element={<MediaSharedContextProbePage />} />
          <Route path="/editor/__wc-decoder-gate" element={<WcDecoderGatePage />} />
          <Route path="/editor/:projectId" element={<EditorPage />} />
          <Route path="/checkout/:projectId" element={<CheckoutPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/admin/templates" element={<AdminTemplatesPage />} />
          <Route path="/admin/jobs" element={<AdminJobsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

function RouteFallback() {
  return (
    <main className="route-fallback" aria-label="Loading page">
      <span />
    </main>
  );
}
