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
    const entryUrl = (token) => {
      const u = new URL('dsh-qq-bridge/', document.baseURI);
      if (token) u.searchParams.set('token', token);
      return u.href;
    };

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

      const btnStyle = {
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '8px 18px', borderRadius: '20px', cursor: 'pointer',
        fontSize: '14px', fontWeight: 600, color: '#fff', textDecoration: 'none',
        background: 'linear-gradient(135deg, #4f8cff 0%, #6c5ce7 100%)',
        boxShadow: '0 2px 8px rgba(79,140,255,.3)',
        transition: 'transform .15s ease, box-shadow .15s ease',
      };

      return h('div', { style: { padding: '16px' } },
        h('h3', { style: { margin: '0 0 14px', fontSize: '16px' } }, 'QQ 桥接'),
        err ? h('div', { style: { color: '#c00' } }, '状态获取失败：' + err) : null,
        health ? h('div', {},
          row('bridge', health.bridge === 'running' ? '✅ 运行中' : '⏸ 停止'),
          row('bridgePath', h('code', { style: { fontSize: '12px' } }, String(health.bridgePath || '—'))),
          h('div', { style: { marginTop: '16px' } },
            h('a', {
              href: entryUrl(health.consoleToken || ''),
              target: '_blank', rel: 'noreferrer',
              style: btnStyle,
              ...(health.consoleToken ? {} : { onClick: 'alert(\'控制台令牌获取失败，请手动输入\')' }),
            }, h('span', {}, '🔧 打开控制台')),
          ),
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
