// dsh-qq-bridge 插件 · 前端（设置页）
// 在 DSH WebUI 设置里注册「QQ 桥接」section，展示 bridge/memory-rag 状态 + 控制台入口。
// 参照 dsh-feiyu-mood client.js 模式：window.__ModuleLoader__.load({ id, factory }).
window.__ModuleLoader__.load({
  id: 'dsh-qq-bridge',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    // 相对路径：DSH 部署在子路径时由 <base href> 自动补前缀（见 dsh-feiyu-mood）
    // API/链接都用 document.baseURI 解析，确保带正确前缀（/app/fn-deepseek-harness/…）
    const apiUrl = (p) => new URL('dsh-qq-bridge/' + p, document.baseURI).href;
    const entryUrl = () => new URL('dsh-qq-bridge/', document.baseURI).href;

    function Panel() {
      const [health, setHealth] = React.useState(null);
      const [err, setErr] = React.useState('');

      React.useEffect(() => {
        let alive = true;
        fetch(apiUrl('health'), { headers: { accept: 'application/json' } })
          .then((r) => r.json())
          .then((d) => { if (alive) setHealth(d); })
          .catch((e) => { if (alive) setErr(String(e?.message || e)); });
        return () => { alive = false; };
      }, []);

      const row = (label, val) => h('div', { style: { margin: '8px 0', display: 'flex', gap: '8px', alignItems: 'center' } },
        h('span', { style: { minWidth: '90px', color: '#888' } }, label),
        h('span', {}, val),
      );

      return h('div', { style: { padding: '12px' } },
        h('h3', { style: { margin: '0 0 12px' } }, 'QQ 桥接'),
        err ? h('div', { style: { color: '#c00' } }, '状态获取失败：' + err) : null,
        health ? h('div', {},
          row('bridge', health.bridge === 'running' ? '✅ 运行中' : '⏸ 停止'),
          row('bridgePath', h('code', {}, String(health.bridgePath || '—'))),
          row('控制台', h('a', { href: entryUrl(), target: '_blank', rel: 'noreferrer' }, '打开控制台 →')),
        ) : (err ? null : h('div', { style: { color: '#888' } }, '加载中…')),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots;
        if (!slots) return;
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'qq-bridge', order: 60, label: 'QQ 桥接' },
          () => h(Panel),
        ));
      },
    };
  },
});
