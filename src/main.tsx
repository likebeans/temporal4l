import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './online.css';
import './lab.css';

const App = lazy(() => import.meta.env.MODE === 'pages'
  ? import('./components/OnlineLearning')
  : import('./App'));

const root = document.getElementById('root');

if (!root) {
  throw new Error('找不到应用挂载节点 #root');
}

createRoot(root).render(
  <StrictMode>
    <Suspense fallback={<p className="page-shell" role="status">正在加载 Temporal 学习内容…</p>}>
      <App />
    </Suspense>
  </StrictMode>,
);
