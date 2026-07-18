import { useEffect, useRef, useState } from "react";
import { Link, Navigate, NavLink, useParams } from "react-router-dom";
import {
  cookbookSections,
  defaultCookbookSectionId,
  getCookbookSection
} from "./cookbook/cookbook-content";

export function CookbookPage() {
  const { sectionId } = useParams();
  const section = getCookbookSection(sectionId);
  const [activeSubId, setActiveSubId] = useState<string>("");
  const articleRef = useRef<HTMLElement | null>(null);

  // Scrollspy: highlight the right-rail entry for whichever subsection is in view.
  useEffect(() => {
    if (!section) {
      return;
    }
    setActiveSubId(section.subsections[0]?.id ?? "");
    const root = articleRef.current;
    if (!root) {
      return;
    }
    const targets = section.subsections
      .map((sub) => root.querySelector<HTMLElement>(`#${CSS.escape(`section-${sub.id}`)}`))
      .filter((el): el is HTMLElement => Boolean(el));

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible?.target instanceof HTMLElement) {
          setActiveSubId(visible.target.dataset.subId ?? "");
        }
      },
      { rootMargin: "-96px 0px -55% 0px", threshold: 0 }
    );
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [section]);

  if (!sectionId) {
    return <Navigate to={`/cookbook/${defaultCookbookSectionId}`} replace />;
  }
  if (!section) {
    return <Navigate to={`/cookbook/${defaultCookbookSectionId}`} replace />;
  }

  const SectionIcon = section.icon;

  return (
    <div className="mkt-page">
      <section className="mkt-hero" style={{ padding: "48px 0 8px" }}>
        <div className="mkt-wrap mkt-hero-inner">
          <span className="mkt-eyebrow">Cookbook</span>
          <h1 style={{ fontSize: "clamp(28px, 3.6vw, 42px)" }}>
            How Orreris works — <span className="mkt-grad">all of it.</span>
          </h1>
          <p className="mkt-sub">
            A no-secrets tour: what the product is, how a reel flows from raw clip to export, and exactly
            how each tool works behind the scenes.
          </p>
        </div>
      </section>

      <div className="mkt-wrap">
        <div className="mkt-doc-shell">
          <nav className="mkt-doc-rail mkt-doc-rail-left mkt-doc-nav" aria-label="Cookbook sections">
            <span className="mkt-doc-rail-title">Sections</span>
            {cookbookSections.map((item) => {
              const ItemIcon = item.icon;
              return (
                <NavLink key={item.id} to={`/cookbook/${item.id}`} className={({ isActive }) => (isActive ? "is-active" : "")}>
                  <span className="lbl">
                    <ItemIcon size={15} />
                    {item.title}
                  </span>
                  <small>{item.blurb}</small>
                </NavLink>
              );
            })}
          </nav>

          <article className="mkt-doc-article" ref={articleRef}>
            <header className="mkt-doc-head">
              <span className="mkt-ic"><SectionIcon size={18} /></span>
              <div>
                <h2>{section.title}</h2>
                <p>{section.blurb}</p>
              </div>
            </header>

            {section.subsections.map((sub) => (
              <section key={sub.id} id={`section-${sub.id}`} data-sub-id={sub.id} className="mkt-doc-sub">
                <h3>{sub.title}</h3>
                <div className="mkt-doc-prose">{sub.render()}</div>
              </section>
            ))}

            <footer className="mkt-doc-foot">
              <Link to="/tools">Browse the tools →</Link>
              <Link to="/create">Start a project →</Link>
            </footer>
          </article>

          <aside className="mkt-doc-rail mkt-doc-rail-right mkt-doc-toc" aria-label="On this page">
            <span className="mkt-doc-rail-title">On this page</span>
            {section.subsections.map((sub) => (
              <a key={sub.id} href={`#section-${sub.id}`} className={activeSubId === sub.id ? "is-active" : ""}>
                {sub.title}
                <small>{sub.descriptor}</small>
              </a>
            ))}
          </aside>
        </div>
      </div>
    </div>
  );
}
