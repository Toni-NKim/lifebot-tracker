import { PlannerPage } from './Planner.js';
import { TodosPage } from './Todos.js';
import { useEffect } from 'react';
import { NavLink, Route, Routes, Link, useLocation } from 'react-router-dom';
import { TodayPage } from './Today.js';
import { Management } from './Management.js';
import { HistoryPage, StatisticsPage, SettingsPage } from './Reports.js';
import { Icon, type IconName } from '../components/icons.js';
import styles from '../styles/layout.module.css';
const SIDEBAR: [string, string, IconName][] = [
  ['/', 'Today', 'dashboard'],
  ['/todos', 'Todo', 'habits'],
  ['/habits/today', '대시보드', 'dashboard'],
  ['/statistics', '분석', 'stats'],
  ['/history', '기록', 'history'],
  ['/habits', '습관', 'habits'],
  ['/routines', '루틴', 'routines'],
  ['/settings', '설정', 'settings'],
];
const TABS: [string, string, IconName][] = [
  ['/', 'Today', 'dashboard'],
  ['/todos', 'Todo', 'habits'],
  ['/habits/today', '대시보드', 'dashboard'],
  ['/statistics', '분석', 'stats'],
  ['/history', '기록', 'history'],
  ['/habits', '관리', 'routines'],
];
// The mobile 관리 tab covers Habits, Routines and Settings.
const MANAGE = ['/habits', '/routines', '/settings'];
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
          LIFEbot
        </Link>
        <nav aria-label="주요 메뉴" className={styles.sideNav}>
          {SIDEBAR.map(([to, label, icon]) => (
            <NavLink
              key={to}
              to={to}
              end
              className={({ isActive }) => (isActive ? styles.active : '')}
            >
              <Icon name={icon} size={18} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className={styles.foot}>Obsidian Vault에 저장됨</div>
      </aside>
      <main className={styles.main}>
        <Routes>
          <Route path="/" element={<PlannerPage />} />
          <Route path="/todos" element={<TodosPage />} />
          <Route path="/habits/today" element={<TodayPage />} />
          <Route path="/habits" element={<Management kind="habit" />} />
          <Route path="/routines" element={<Management kind="routine" />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/statistics" element={<StatisticsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="*"
            element={
              <p>
                페이지를 찾을 수 없어요. <Link to="/">대시보드로 돌아가기</Link>
              </p>
            }
          />
        </Routes>
      </main>
      <nav aria-label="하단 메뉴" className={styles.tabBar}>
        {TABS.map(([to, label, icon]) => {
          const active =
            to === '/habits' ? MANAGE.includes(location.pathname) : location.pathname === to;
          return (
            <Link
              key={to}
              to={to}
              aria-current={active ? 'page' : undefined}
              className={active ? styles.active : ''}
            >
              <Icon name={icon} size={22} strokeWidth={active ? 2.2 : 1.8} />
              {label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
