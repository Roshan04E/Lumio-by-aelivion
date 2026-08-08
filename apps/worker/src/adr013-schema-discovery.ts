/**
 * ADR-013 real-project measurement — STEP 0, schema discovery. Not a measurement.
 *
 * Answers three questions that decide how the real fixture is BUILT, none of which can be settled by
 * reading source alone:
 *
 *   1. Does the demo/guest path produce a real JWT (server-side project, PATCH-able) or a guest session
 *      (local-only project)? My memory note says the seeded demo login 401s and the route in is "Try the
 *      demo", which strongly suggests guest — and a guest project cannot be PATCHed through the API.
 *   2. What does a REAL Flarex comp's persisted JSON actually look like? The fixture needs 3 hosts with
 *      3/2/1 asset-source MediaIns at exact times; hand-writing that schema from type declarations is
 *      how you get a fixture that loads but declares no sources (the documented "cliff").
 *   3. Where does the project actually live, so the fixture can be injected there?
 *
 * Writes everything to tmp/adr013-schema/. Measures nothing, asserts nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { EDITOR_BASE, addAssetSourceMediaIn, defaultClipPath, importAssets, reachEditor } from "./browser/editor-session.js";

const OUT_DIR = path.join(process.cwd(), "..", "..", "tmp", "adr013-schema");

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) {
    console.warn("[schema] ⚠ PIXEL_BROWSER_CHANNEL unset — fine for schema discovery, NOT for measurement.");
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch(channel ? { headless: false, channel } : { headless: false });
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await context.newPage();
  page.on("console", (m) => {
    const t = m.text();
    if (/flarex|error|warn/i.test(t)) console.log(`  [page] ${t.slice(0, 200)}`);
  });

  try {
    console.log("[schema] reaching editor…");
    const url = await reachEditor(page);
    console.log(`[schema] editor at ${url}`);
    const projectId = url.split("/editor/")[1]?.split(/[?#]/)[0] ?? null;
    console.log(`[schema] projectId = ${projectId}`);

    // Q1: real JWT or guest?
    const auth = await page.evaluate(() => {
      const token = localStorage.getItem("orreris_token");
      return {
        token: token ? (token === "mock-local-token" ? "MOCK" : `REAL(${token.length} chars)`) : "ABSENT",
        allKeys: Object.keys(localStorage),
      };
    });
    console.log(`[schema] auth token: ${auth.token}`);
    console.log(`[schema] localStorage keys (${auth.allKeys.length}): ${auth.allKeys.join(", ").slice(0, 600)}`);

    // Import a few more assets so the fixture has distinct sources to bind MediaIns to.
    const clip = defaultClipPath();
    console.log(`[schema] importing extra assets from ${clip}…`);
    const imported = await importAssets(page, [clip]).catch((e) => {
      console.log(`[schema] importAssets threw: ${String(e).slice(0, 200)}`);
      return -1;
    });
    console.log(`[schema] importAssets -> ${imported}`);

    // Q2: build ONE real comp with an asset-source MediaIn, via the UI, so the JSON is genuine.
    console.log("[schema] building one asset-source MediaIn via UI…");
    const built = await addAssetSourceMediaIn(page);
    console.log(`[schema] addAssetSourceMediaIn -> ${JSON.stringify(built)}`);

    await page.waitForTimeout(3000);

    // Q3: where does it live? Try the API first (needs a real JWT), then dump local stores.
    const dump = await page.evaluate(async (pid) => {
      const out: Record<string, unknown> = {};
      const token = localStorage.getItem("orreris_token");
      out.tokenKind = token ? (token === "mock-local-token" ? "MOCK" : "REAL") : "ABSENT";

      if (token && token !== "mock-local-token" && pid) {
        try {
          const res = await fetch(`/api/projects/${pid}`, { headers: { Authorization: `Bearer ${token}` } });
          out.apiStatus = res.status;
          if (res.ok) out.apiProject = await res.json();
        } catch (e) {
          out.apiError = String(e);
        }
      }

      // Local stores: dump any localStorage value that looks like a project/composition.
      const local: Record<string, unknown> = {};
      for (const k of Object.keys(localStorage)) {
        const v = localStorage.getItem(k) ?? "";
        if (/project|composition|flarex|timeline/i.test(k) || /flarexComps|"tracks"/.test(v.slice(0, 2000))) {
          local[k] = v.length > 400_000 ? `<${v.length} chars, truncated>` : v;
        }
      }
      out.localStorageCandidates = local;

      // IndexedDB database names, if the browser supports enumerating them.
      try {
        const dbs = (indexedDB as unknown as { databases?: () => Promise<{ name?: string }[]> }).databases;
        if (dbs) out.indexedDbNames = (await dbs.call(indexedDB)).map((d) => d.name);
      } catch (e) {
        out.indexedDbError = String(e);
      }
      return out;
    }, projectId);

    fs.writeFileSync(path.join(OUT_DIR, "discovery.json"), JSON.stringify(dump, null, 2), "utf8");
    console.log(`[schema] wrote discovery.json (${JSON.stringify(dump).length} bytes)`);
    console.log(`[schema] tokenKind=${dump.tokenKind} apiStatus=${dump.apiStatus ?? "n/a"}`);
    console.log(`[schema] localStorage candidate keys: ${Object.keys((dump.localStorageCandidates as object) ?? {}).join(", ")}`);
    console.log(`[schema] indexedDB: ${JSON.stringify(dump.indexedDbNames ?? dump.indexedDbError ?? "n/a")}`);

    // The graph itself, however we got it.
    const graph =
      (dump.apiProject as { data?: { project?: { projectGraph?: unknown } } } | undefined)?.data?.project?.projectGraph ?? null;
    if (graph) {
      fs.writeFileSync(path.join(OUT_DIR, "project-graph.json"), JSON.stringify(graph, null, 2), "utf8");
      console.log("[schema] wrote project-graph.json from API");
    } else {
      console.log("[schema] no API graph — see discovery.json localStorageCandidates / indexedDbNames");
    }
  } finally {
    await page.waitForTimeout(1500);
    await context.close();
    await browser.close();
  }
}

main().catch((e) => {
  console.error("[schema] FAILED", e);
  process.exit(1);
});
