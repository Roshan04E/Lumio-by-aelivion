import { useEffect, useRef, useState } from "react";
import { Link, Navigate, NavLink, useParams } from "react-router-dom";
import { Badge } from "../components/Badge";
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
    <div className="page cookbook-page">
      <section className="page-heading cookbook-hero">
        <Badge tone="lime">Cookbook</Badge>
        <h1>How ReelForge works — all of it</h1>
        <p>
          A guided, no-secrets tour of the product: what it is, who it's for, how a reel flows from raw clip to export, and
          exactly how each tool works behind the scenes.
        </p>
      </section>

      <div className="cookbook-shell">
        <nav className="cookbook-rail cookbook-rail-left" aria-label="Cookbook sections">
          <span className="cookbook-rail-title">Sections</span>
          {cookbookSections.map((item) => {
            const ItemIcon = item.icon;
            return (
              <NavLink
                key={item.id}
                to={`/cookbook/${item.id}`}
                className={({ isActive }) => (isActive ? "is-active" : "")}
              >
                <span className="cookbook-rail-label">
                  <ItemIcon size={15} />
                  {item.title}
                </span>
                <small>{item.blurb}</small>
              </NavLink>
            );
          })}
        </nav>

        <article className="cookbook-article" ref={articleRef}>
          <header className="cookbook-article-head">
            <span className="cookbook-article-icon">
              <SectionIcon size={20} />
            </span>
            <div>
              <h2>{section.title}</h2>
              <p>{section.blurb}</p>
            </div>
          </header>

          {section.subsections.map((sub) => (
            <section
              key={sub.id}
              id={`section-${sub.id}`}
              data-sub-id={sub.id}
              className="cookbook-subsection"
            >
              <h3>{sub.title}</h3>
              <div className="cookbook-prose">{sub.render()}</div>
            </section>
          ))}

          <footer className="cookbook-article-foot">
            <Link to="/tools">Browse the tools →</Link>
            <Link to="/create">Start a project →</Link>
          </footer>
        </article>

        <aside className="cookbook-rail cookbook-rail-right" aria-label="On this page">
          <span className="cookbook-rail-title">On this page</span>
          {section.subsections.map((sub) => (
            <a
              key={sub.id}
              href={`#section-${sub.id}`}
              className={activeSubId === sub.id ? "is-active" : ""}
            >
              <span className="cookbook-rail-label">{sub.title}</span>
              <small>{sub.descriptor}</small>
            </a>
          ))}
        </aside>
      </div>
    </div>
  );
}
