import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";

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
const AuthPage = lazy(() => import("./pages/AuthPage").then((module) => ({ default: module.AuthPage })));

export default function App() {
  return (
    <AppShell>
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
