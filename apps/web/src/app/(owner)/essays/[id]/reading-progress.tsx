"use client";
// Reading progress for the reader: how far the page has been scrolled. Not saved yet (reading_progress
// persistence is not part of this slice).
import { useEffect, useState } from "react";
import styles from "./reader.module.css";

export function ReadingProgress() {
  const [pct, setPct] = useState(0);

  useEffect(() => {
    const update = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      setPct(scrollable <= 0 ? 100 : Math.min(100, Math.max(0, (window.scrollY / scrollable) * 100)));
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return <progress className={styles.progress} value={Math.round(pct)} max={100} aria-label="Reading progress" />;
}
