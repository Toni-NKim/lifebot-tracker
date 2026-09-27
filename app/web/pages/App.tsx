import { useEffect } from 'react';
import { NavLink, Route, Routes, Link, useLocation } from 'react-router-dom';
import { TodayPage } from './Today.js';
import { Management } from './Management.js';
import { HistoryPage, StatisticsPage, SettingsPage } from './Reports.js';
import styles from '../styles/app.module.css';
export function App() {
  const location = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link to="/" className={styles.brand}>
          <span className={styles.logo}>h.</span>
          <span>
            Habit tracker<small>A little, every day.</small>
          </span>
        </Link>
        <nav aria-label="Main navigation">
          {[
            ['/', 'Today', '◉'],
            ['/habits', 'Habits', '✓'],
            ['/routines', 'Routines', '☷'],
            ['/history', 'History', '◷'],
            ['/statistics', 'Statistics', '▥'],
            ['/settings', 'Settings', '⚙'],
          ].map(([to, label, icon]) => (
            <NavLink
              key={to}
              to={to}
              end
              className={({ isActive }) => (isActive ? styles.activeNav : '')}
            >
              <span aria-hidden="true">{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className={styles.sidebarFoot}>
          YOUR PERSONAL SPACE
          <br />
          <strong>One day at a time.</strong>
        </div>
      </aside>
      <main className={styles.main}>
        <Routes>
          <Route path="/" element={<TodayPage />} />
          <Route path="/habits" element={<Management kind="habit" />} />
          <Route path="/routines" element={<Management kind="routine" />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/statistics" element={<StatisticsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="*"
            element={
              <p>
                Page not found. <Link to="/">Back to Today</Link>
              </p>
            }
          />
        </Routes>
        <footer className={styles.footer}>Stored in your Obsidian Vault · Private by design</footer>
      </main>
    </div>
  );
}
