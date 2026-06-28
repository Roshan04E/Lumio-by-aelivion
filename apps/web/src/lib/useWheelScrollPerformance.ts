import { useEffect, type RefObject } from "react";

const wheelScrollClassName = "is-wheel-scrolling";

export function useWheelScrollPerformance<T extends HTMLElement>(ref: RefObject<T | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const scrollElement = element;
    let timeout = 0;
    function markWheelScrolling() {
      scrollElement.classList.add(wheelScrollClassName);
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        scrollElement.classList.remove(wheelScrollClassName);
      }, 140);
    }

    scrollElement.addEventListener("wheel", markWheelScrolling, { passive: true });
    return () => {
      window.clearTimeout(timeout);
      scrollElement.classList.remove(wheelScrollClassName);
      scrollElement.removeEventListener("wheel", markWheelScrolling);
    };
  }, [ref]);
}
